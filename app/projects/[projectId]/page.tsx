import { DotsConsole } from "@/components/dots/console";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <DotsConsole section="projects" projectId={projectId} />;
}
