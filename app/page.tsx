import { currentUser } from "@/app/lib/auth/access";
import WorkspaceDashboard from "./components/WorkspaceDashboard";
import LoginLanding from "./components/LoginLanding";
import { resolveQqGroupUrl } from "./lib/landing-links";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (user) return <WorkspaceDashboard userName={user.name} />;
  return <LoginLanding groupUrl={resolveQqGroupUrl()} />;
}
