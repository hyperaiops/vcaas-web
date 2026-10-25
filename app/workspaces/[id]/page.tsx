import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/app/lib/auth/access";
import { getOwnedWorkspace } from "@/app/lib/db";
import WorkspaceEditor from "@/app/components/WorkspaceEditor";

export const dynamic = "force-dynamic";

export default async function WorkspaceEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/auth/login?returnTo=${encodeURIComponent(`/workspaces/${id}`)}`);
  if (!getOwnedWorkspace(id, user.id)) notFound();
  return <WorkspaceEditor userName={user.name} />;
}
