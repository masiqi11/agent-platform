import { CheckCircle2, FolderKanban, Inbox } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/lib/i18n";
import { useMe } from "@/lib/me";

export function HomePage() {
  const { data: me } = useMe();
  return (
    <div>
      <PageHeader title={t("home.greeting", { name: me?.displayName ?? "" })} description={me?.tenant.name} />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section aria-labelledby="projects-h">
          <h2 id="projects-h" className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <FolderKanban className="size-4" /> {t("home.projects")}
          </h2>
          <EmptyState icon={FolderKanban} title="暂无项目" body={t("home.noProjects")} />
        </section>
        <Card className="h-fit gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Inbox className="size-4 text-attention" /> {t("home.needs")}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-ok" /> {t("home.nothing")}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function InboxPage() {
  return (
    <div>
      <PageHeader title={t("inbox.title")} />
      <EmptyState icon={Inbox} title="一切就绪" body={t("inbox.empty")} />
    </div>
  );
}
