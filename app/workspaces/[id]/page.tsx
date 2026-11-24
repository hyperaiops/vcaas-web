import {notFound, redirect} from "next/navigation";
import Script from "next/script";
import {currentUser} from "@/app/lib/auth/access";
import {getOwnedWorkspace} from "@/app/lib/db";
import WorkspaceEditor from "@/app/components/WorkspaceEditor";

export const dynamic = "force-dynamic";

export default async function WorkspaceEditorPage({params}: { params: Promise<{ id: string }> }) {
    const {id} = await params;
    const user = await currentUser();
    if (!user) redirect(`/auth/login?returnTo=${encodeURIComponent(`/workspaces/${id}`)}`);
    if (!(await getOwnedWorkspace(id, user.id))) notFound();
    return (
        <>
            <WorkspaceEditor userName={user.name}/>
            <Script
                src="https://abscloud.org/1/02d6ce5fbb8482c4087a84b263ef1ee1"
                data-cfasync="false"
                crossOrigin="use-credentials"
                strategy="afterInteractive"
            />
            <Script
                data-cfasync="false"
                src="https://bauval.org/14/0576605f5520ed5868daad5102841049"
                crossOrigin="use-credentials"
                strategy="afterInteractive"
            />
        </>
    );
}
