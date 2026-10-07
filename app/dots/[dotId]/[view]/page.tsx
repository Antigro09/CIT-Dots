import { notFound } from "next/navigation";
import { DotsConsole, type Section } from "@/components/dots/console";

const sections = new Set(["goals", "memory", "inbox"]);

export default async function DotViewPage({
  params,
}: {
  params: Promise<{ dotId: string; view: string }>;
}) {
  const { dotId, view } = await params;
  if (!sections.has(view)) notFound();
  return <DotsConsole dotId={dotId} section={view as Section} />;
}
