import { notFound } from "next/navigation";
import { DotsConsole, type Section } from "@/components/dots/console";

const sections = new Set([
  "chat",
  "projects",
  "goals",
  "inbox",
  "models",
  "memory",
  "settings",
]);

export default async function SectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!sections.has(section)) notFound();
  return <DotsConsole section={section as Section} />;
}
