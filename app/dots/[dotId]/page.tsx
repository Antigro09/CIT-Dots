import { DotsConsole } from "@/components/dots/console";

export default async function DotPage({
  params,
}: {
  params: Promise<{ dotId: string }>;
}) {
  const { dotId } = await params;
  return <DotsConsole dotId={dotId} />;
}
