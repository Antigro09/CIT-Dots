import { DotsConsole } from "@/components/dots/console";

export default async function TaskPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  return <DotsConsole section="task" taskId={taskId} />;
}
