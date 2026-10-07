import { DotsConsole } from "@/components/dots/console";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <DotsConsole sessionId={sessionId} />;
}
