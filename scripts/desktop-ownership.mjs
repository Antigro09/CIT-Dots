import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Match DesktopManager's ownership scope without reading its private metadata.
export function desktopOwner(applicationDir) {
  return createHash("sha256")
    .update(resolve(applicationDir))
    .digest("hex")
    .slice(0, 24);
}

export function ownedDesktopFilters(applicationDir) {
  return [
    "--filter",
    "label=cit-dots.managed=true",
    "--filter",
    "label=cit-dots.desktop=true",
    "--filter",
    `label=cit-dots.desktop.owner=${desktopOwner(applicationDir)}`,
  ];
}
