-- §1.3 success metrics, computed from the database only (read-only; safe on production).
--   psql "$DATABASE_URL" -v tenant="'ten_…'" -v since="'2026-11-01'" -f docs/metrics.sql
-- Every query takes :tenant and :since (inclusive lower bound on the metric's own timestamp).
-- Each returns one row: the measured value(s), the sample size, and whether the target is met.

\echo '1. 群内决策 → 任务创建（目标 < 5 分钟；只统计由提议确认产生的任务）'
with t as (
  select tk.id,
         extract(epoch from tk.created_at - (select max(m.created_at) from message m where m.id in (select jsonb_array_elements_text(p.source_message_ids)))) as secs
  from proposal p
  cross join lateral jsonb_array_elements_text(p.result_task_ids) r(task_id)
  join task tk on tk.id = r.task_id
  where p.tenant_id = :tenant and p.kind = 'create_task' and p.status = 'accepted' and tk.created_at >= :since::timestamptz
)
select count(*) as tasks,
       round((percentile_cont(0.5) within group (order by secs))::numeric / 60, 1) as p50_minutes,
       round((percentile_cont(0.9) within group (order by secs))::numeric / 60, 1) as p90_minutes,
       coalesce(percentile_cont(0.5) within group (order by secs) < 300, true) as target_met
from t where secs is not null;

\echo '2. 任务开始 → 首个 MR（目标 < 1 个工作日；此处按自然小时计，8 小时为一个工作日）'
with started as (
  select coalesce(e.payload ->> 'taskId', e.aggregate_id) as task_id, min(e.occurred_at) as at
  from event e
  where e.tenant_id = :tenant and e.type = 'task.status_changed' and e.payload ->> 'to' = 'in_progress' and e.occurred_at >= :since::timestamptz
  group by 1
), mr as (
  select e.payload ->> 'taskId' as task_id, min(e.occurred_at) as at
  from event e where e.tenant_id = :tenant and e.type = 'mr.opened' group by 1
)
select count(*) as tasks,
       round((percentile_cont(0.5) within group (order by extract(epoch from mr.at - s.at)))::numeric / 3600, 2) as p50_hours,
       coalesce(percentile_cont(0.5) within group (order by extract(epoch from mr.at - s.at)) < 8 * 3600, true) as target_met
from started s join mr on mr.task_id = s.task_id and mr.at >= s.at;

\echo '3. 首次测试通过率（目标 ≥ 60%）'
with first_run as (
  select distinct on (tr.task_id) tr.task_id, tr.status
  from test_run tr
  where tr.tenant_id = :tenant and tr.status in ('passed', 'failed') and tr.created_at >= :since::timestamptz
  order by tr.task_id, tr.created_at
)
select count(*) as tasks,
       round(100.0 * count(*) filter (where status = 'passed') / nullif(count(*), 0), 1) as first_pass_pct,
       coalesce(100.0 * count(*) filter (where status = 'passed') / nullif(count(*), 0) >= 60, true) as target_met
from first_run;

\echo '4. 每个合并任务的人工干预次数（目标 ≤ 2；扣除确认提议与合并审批各 1 次）'
with merged as (
  select rr.task_id from release_record rr where rr.tenant_id = :tenant and rr.created_at >= :since::timestamptz
), human_writes as (
  select m.task_id, count(e.id) as n
  from merged m
  join event e on e.tenant_id = :tenant and (e.aggregate_id = m.task_id or e.payload ->> 'taskId' = m.task_id)
  join principal pr on pr.id = e.actor_principal_id and pr.kind = 'human'
  group by m.task_id
)
select count(*) as merged_tasks,
       round(avg(greatest(coalesce(h.n, 0) - 2, 0)), 2) as avg_interventions,
       max(greatest(coalesce(h.n, 0) - 2, 0)) as max_interventions,
       coalesce(avg(greatest(coalesce(h.n, 0) - 2, 0)) <= 2, true) as target_met
from merged m left join human_writes h on h.task_id = m.task_id;

\echo '5. 船长摘要被人类修正的比例（目标 < 10%；按摘要版本计：被修正生成的版本 / 全部版本）'
select count(*) as summary_versions,
       count(*) filter (where corrected_by is not null) as corrected_versions,
       round(100.0 * count(*) filter (where corrected_by is not null) / nullif(count(*), 0), 1) as corrected_pct,
       coalesce(100.0 * count(*) filter (where corrected_by is not null) / nullif(count(*), 0) < 10, true) as target_met
from summary where tenant_id = :tenant and created_at >= :since::timestamptz;

\echo '6. 知识库回答带有效引用（目标 100%：有引用，或明确标为"未检索到依据"）'
-- kb.answered (S8) carries counts only. Citations are chunks of the active index at answer time,
-- so a cited path exists at that commit by construction.
select count(*) as answers,
       count(*) filter (where (payload ->> 'citations')::int > 0) as cited,
       count(*) filter (where (payload ->> 'noEvidence')::boolean) as no_evidence,
       count(*) filter (where (payload ->> 'fallback')::boolean) as fallback_cited,
       round(100.0 * count(*) filter (where (payload ->> 'citations')::int > 0 or (payload ->> 'noEvidence')::boolean) / nullif(count(*), 0), 1) as grounded_pct,
       coalesce(count(*) filter (where (payload ->> 'citations')::int > 0 or (payload ->> 'noEvidence')::boolean) = count(*), true) as target_met
from event where tenant_id = :tenant and type = 'kb.answered' and occurred_at >= :since::timestamptz;

\echo '7. 单任务平均模型成本（目标：在配置的上限内；USD 按登记价格计算，tokens 按供应商用量）'
with per_task as (
  select task_id, sum(cost) as cost, sum(tokens_in + tokens_out) as tokens, count(*) as calls
  from llm_call where tenant_id = :tenant and task_id is not null and created_at >= :since::timestamptz
  group by task_id
)
select count(*) as tasks,
       round(avg(cost)::numeric, 4) as avg_cost_usd,
       round(max(cost)::numeric, 4) as max_cost_usd,
       round(avg(tokens)) as avg_tokens,
       round(avg(calls), 1) as avg_calls
from per_task;
