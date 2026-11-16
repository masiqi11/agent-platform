/** UI dictionary (§13.9). Components use t("key"); English can be added as another table. */
const zh = {
  "app.name": "协作台",
  "app.tagline": "人与 Agent 在同一条时间线上协作",
  "nav.home": "工作台",
  "nav.inbox": "收件箱",
  "nav.projects": "项目",
  "nav.admin": "管理",
  "nav.audit": "审计",
  "nav.users": "成员与邀请",
  "nav.settings": "设置",
  "nav.chat": "对话",
  "nav.board": "看板",
  "nav.knowledge": "知识库",
  "nav.agents": "Agent",
  "top.search": "搜索或执行命令…",
  "top.theme": "切换主题",
  "theme.light": "浅色",
  "theme.dark": "深色",
  "theme.system": "跟随系统",
  "user.signout": "退出登录",
  "state.loading": "加载中",
  "state.retry": "重试",
  "state.error": "出了点问题",
  "state.traceId": "追踪号",
  "state.forbidden.title": "没有权限",
  "state.forbidden.body": "这个页面需要「{required}」角色。请联系租户管理员为你开通。",
  "state.notfound.title": "页面不存在",
  "state.notfound.body": "链接可能已失效，或者它属于另一个租户。",
  "state.back": "返回工作台",
  "conn.lost": "连接已断开，正在重连…",
  "conn.restored": "已重新连接，数据已同步",
  "session.expired.title": "登录已过期",
  "session.expired.body": "请重新登录，当前页面与未提交的输入会保留。",
  "login.title": "登录",
  "login.email": "邮箱",
  "login.password": "密码",
  "login.submit": "登录",
  "login.oidc": "使用企业 SSO 登录",
  "login.dev": "开发模式一键登录",
  "login.failed": "账号或密码错误",
  "setup.title": "初始化系统",
  "setup.subtitle": "创建租户与第一位负责人账号。完成后此页面自动关闭。",
  "setup.tenant": "团队 / 公司名称",
  "setup.name": "你的名字",
  "setup.submit": "创建并进入",
  "invite.title": "接受邀请",
  "invite.submit": "加入团队",
  "reset.title": "设置新密码",
  "reset.submit": "保存新密码",
  "users.title": "成员与邀请",
  "users.invite": "邀请成员",
  "users.empty": "还没有其他成员。发一个邀请链接，把同事拉进来。",
  "audit.title": "审计日志",
  "audit.verify": "校验哈希链",
  "audit.export": "导出 CSV",
  "audit.empty": "没有符合条件的审计记录。",
  "home.greeting": "你好，{name}",
  "home.needs": "需要我处理",
  "home.projects": "项目",
  "home.noProjects": "还没有项目。项目创建后，摘要、任务和 Agent 状态会出现在这里。",
  "home.nothing": "目前没有需要你处理的事项。",
  "inbox.title": "收件箱",
  "inbox.empty": "收件箱是空的。审批、被提及和阻塞任务会出现在这里。",
} as const;

export type MsgKey = keyof typeof zh;
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = zh[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
export function relativeTime(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "刚刚";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(iso).toLocaleDateString("zh-CN");
}
export const absoluteTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
