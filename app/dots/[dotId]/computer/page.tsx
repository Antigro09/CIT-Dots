import { DotsConsole } from "@/components/dots/console";

export default async function DotComputerPage({
  params,
}: {
  params: Promise<{ dotId: string }>;
}) {
  const { dotId } = await params;
  return <DotsConsole dotId={dotId} section="computer" />;
}
