# Dots and Muse: official product research

Sources checked on **October 7, 2026**. OpenAI's launch article is dated **September 29, 2026**. These are public product behaviors, not a description of private implementation details.

## What OpenAI documents

Dots are ongoing agents that carry work forward between conversations, use connected tools and Codex, and return progress, results and decisions for review. A dot can coordinate several responsibilities rather than requiring a new request for every step. [ChatGPT Dots](https://chatgpt.com/features/dots/)

Each dot has its own cloud computer. The user can inspect it, take control and return control. Its files, software and browser sessions can persist between periods of use, and cloud work can continue while the user's own devices are off. Connecting a personal computer is a separate, optional permission; local work requires that computer to stay online with the ChatGPT app running. [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

A dot can start separate cloud threads, delegate to Work or Codex, and use background agents while the user continues talking to it. The setup documentation describes personalization of its name, shape, color, eyes, glasses and accessories. [Getting started](https://learn.chatgpt.com/docs/dots/getting-started)

The Help Center also documents selectable characters or pets and generated pets. It describes a Reset flow that deletes a dot, its conversations, memories and scheduled tasks. It does not establish a nondeletable first dot. [Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)

A dot starts with relevant ChatGPT memory and maintains separate notes about preferences, decisions and ongoing work. Those notes are not a complete transcript. Messaging channels reach the same dot; switching channels does not create a new identity or reset its notes. [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)

OpenAI describes a primary dot at launch. Additional dots and larger allowances are future capabilities in the inspected announcement. It distinguishes proactive read-only research from actions subject to permissions and review. [Introducing dots](https://openai.com/index/introducing-dots/)

## What Meta documents

Muse's official page describes a persistent dedicated virtual machine with a browser, connected apps, goals, background work after its app closes and an activity audit trail. It says Muse can build tools when a task needs them. Certain actions, such as sending messages or purchases, require approval. Muse is free with a usage limit, with an optional paid subscription after that limit. [Muse](https://ai.meta.com/muse/)

Meta advertises Mac, iPhone and Android apps. Its desktop description covers permitted use of local files, apps and browser tabs. This does not establish a supported locally hosted Ubuntu inference stack. [Muse downloads](https://ai.meta.com/muse/download/)

## CIT Dots policy and implementation choices

| Behavior                                  | Public reference evidence                                                                                                          | CIT Dots choice                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Persistent personal identity and memories | Documented for ChatGPT Dots                                                                                                        | Each stored Dot owns its sessions, tasks, goals, memories and inbox                    |
| Editable name and pet appearance          | Documented for ChatGPT Dots                                                                                                        | Editable name, personality and original animated pet                                   |
| First Dot always present                  | A primary dot is documented, but Reset can delete it                                                                               | Automatically create Pip and prevent removal of the primary Dot                        |
| More removable Dots now                   | Additional ChatGPT dots were described as future work                                                                              | Allow extra Dots; removal affects only their owned records and computer files          |
| Independent chat and work sessions        | Separate threads and delegated work are described; these inspected pages do not establish the requested standalone ownership rules | Ordinary chat/work sessions have no Dot owner and survive extra-Dot removal            |
| Own persistent computer                   | Documented for both products                                                                                                       | A real local Ubuntu 26.04/Xfce desktop for each Dot, streamed with noVNC               |
| Isolation technology                      | Muse names a VM; inspected Dots pages do not disclose their host architecture                                                      | Docker containers share the workstation kernel; they are not separate virtual machines |
| Availability with the user's PC off       | Hosted computers can continue                                                                                                      | Local computation runs only while this workstation is awake and services are running   |

These choices implement the user's requested workstation behavior. They should not be presented as current ChatGPT account rules, Meta's architecture or an exact reproduction of either product.

CIT Dots provides interactive graphical desktops and agent file/command tools. It does not currently supply automated screenshot, mouse or keyboard tools; vendor computer-use capabilities should not be inferred from the presence of a desktop.

## Unknowns and access limits

The inspected OpenAI pages do not disclose their OS distribution, hypervisor, storage layout, scheduler or proprietary delegation protocol. Meta identifies a persistent VM but does not provide enough information to reconstruct its service.

OpenAI's feature page, launch article, Help Center and HTML Learn pages were readable through the web tool. Meta's direct page extraction returned no readable lines; indexed results from the official page supplied its product description and FAQ. Learn's advertised `.md` variants returned internal errors, so the HTML versions were used. No authenticated account features or vendor computer internals were inspected.
