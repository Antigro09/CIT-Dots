# Dots: researched behavior and the local implementation contract

Research checked **October 7, 2026** against OpenAI's public product documentation, Help Center, launch announcement and technical system card. The announcement was published September 29, 2026. Meta's official Muse page is a secondary comparison. This report separates public evidence, the user's screenshots and requested local policies. It describes observable behavior; private prompts, internal services and model capabilities are not reproducible from these sources.

## The coordinator model

OpenAI documents a Dot that holds ongoing responsibilities, delegates work and remains available while that work runs. The user can change priorities in the same conversation, rather than manually prompting and tracking each worker. Its own computer and connected tools support that work. [Feature overview](https://chatgpt.com/features/dots/)

The clearest delegation evidence is in the setup guide: a Dot can hand parts of a request to ChatGPT Work or Codex and run background agents concurrently. The user can keep talking to it and review delegated work through Activity. [Getting started](https://learn.chatgpt.com/docs/dots/getting-started)

The technical system card confirms frequent delegation to subagents. It also describes a time budget guiding work duration and evaluations with a deadline, clock and wait tools. It tests permission changes during execution and boundaries across consecutive tasks. This establishes that persistence and delegation are intentional product capabilities, without disclosing their scheduler, tool protocol or proprietary instructions. [GPT-6 Astra system card, Dots appendix, sections 12.1 and 12.3.5](https://deploymentsafety.openai.com/gpt-6-astra)

**CIT Dots contract:** the Dot is the user's coordinator. It understands requests, prompts appropriate workers, checks what they return, gives further instructions when needed, and reports understandable progress or decisions. The Dot conversation contains prose. Coding, command execution and authored deliverables belong to workers. Files produced by those workers can be forwarded when the user requests them. Independent Chat and Work sessions retain their own behavior.

The strict prohibition on direct code output and the requirement to send worker files only on request are **the user's explicit requirements**. The inspected public sources describe delegation but do not say every Dot is prohibited from writing code directly, or that all file sharing must be requested. These requirements should be enforced as local product behavior, not attributed to OpenAI.

## What the official sources establish

### Identity and conversation

The launch describes a named primary Dot, with additional Dots envisioned for the future. Conversations with the Dot are distinct from tasks it starts or manages in Work and Codex. The launch's usage accounting reflects that distinction. [Introducing dots](https://openai.com/index/introducing-dots/)

The Help Center documents editable names, characters and pets, including generated pets. It shows a profile containing activity and computer access, and says proactive and scheduled updates appear in the conversation. It also documents Reset, which deletes the Dot and its own conversation, memories and schedules. Therefore a nondeletable primary Dot is a requested CIT policy rather than a verified ChatGPT restriction. [Help: getting started](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)

### Worker conversations and coordination

Delegated tasks have their own conversations and receive instructions and selected context for the assignment. They do not automatically inherit every conversation with the Dot. The Dot can inspect results and send further instructions using the task's original computer or cloud environment. Task completion alone does not establish that the objective was achieved. [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)

The overview also describes visible cloud threads and local Work/Codex tasks. Both can run while the Dot remains conversationally available. Connecting a computer does not make every existing conversation available to the Dot. [Meet dots](https://learn.chatgpt.com/docs/dots)

### Background work, schedules and notifications

Assigned work can pause and wake without every continuation requiring a fixed schedule. Timed repetition uses a saved schedule with a time zone, notification conditions and destination. Supported event monitoring must be explicitly configured; connecting a service alone does not create a monitor. Proactive research is a separate mode: read-only agents report findings privately to the Dot, which may bring a useful suggestion or question to the user. [Meet dots](https://learn.chatgpt.com/docs/dots)

Contact methods reach the same identity and memory, while their visible conversations remain separate. The user can specify which updates belong in each channel. Ending a voice call does not end assigned work. [Messaging](https://learn.chatgpt.com/docs/dots/channels)

The user's requested notification policy is more specific: send updates only for meaningful progress, a result, a failure or a genuine question. Repeating an unchanged status because a timer fired would violate that preference.

### Computer and environment

A Dot has its own persistent cloud computer, files, software and browser sessions. The user can inspect it, take over mouse and keyboard, and return control. Its browser does not inherit the user's personal browser logins. Cloud threads are separate work conversations; selecting a different computer does not migrate an existing task. [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

Local access is optional and separately granted. Steps on a connected local computer require that computer to be online with the desktop app running. Losing connectivity and revoking access are different states; local child tasks do not automatically migrate into the cloud. [Enterprise local computer access](https://learn.chatgpt.com/docs/enterprise/cloud-local-access)

CIT's per-Dot Ubuntu 26.04/Xfce computer runs locally in Docker. It has a real interactive desktop and persistent owned storage, but shares the workstation's kernel. It is not a separate VM, and it cannot compute while the workstation is off. Human noVNC control does not establish automated screenshot, mouse or keyboard agent tools.

### Memory, permissions and lifecycle

OpenAI distinguishes current conversation context, ChatGPT memory and a Dot's own notes. Notes capture preferences, decisions and responsibilities; they are not a complete transcript. [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)

Permissions apply to delegated and background actions. The privacy FAQ describes shared plugin connections, shared ChatGPT memory controls and a separate Dot context. It also says generated files, Codex threads and other ChatGPT conversations can be stored separately and survive deleting the Dot. That is more specific than treating Reset as deletion of every artifact the Dot ever produced. [Privacy, security and safety FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)

Controls distinguish pausing the parent's current work, stopping an individual delegated task and disabling a recurring schedule. Those operations have different effects. Custom rules guide actions but do not grant access to an app or computer. Activity allows review of progress, files, results and requests for input. [Controls](https://learn.chatgpt.com/docs/dots/controls)

CIT's local policy remains automatic work in approved project folders, with specific approval for external actions. Its broker must enforce that policy for every worker and handoff. A parent's permission cannot expand because it delegated a task.

## Asynchronous dispatch and worker steering

The public documentation supports continued conversation during parallel work, inspection of owned tasks and follow-up instructions to them. It does not document a public internal parameter that controls whether a delegation call waits, or the exact semantics of replacing a running worker prompt. [Getting started](https://learn.chatgpt.com/docs/dots/getting-started), [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

The user's additional local contract makes that behavior explicit: dispatch can return an immediate worker receipt, the Dot can inspect status later, and it can send instructions to an existing worker session. A receipt confirms accepted delegation, not task success. Steering should preserve the worker's session, workspace, ownership and model selection. The implementation must distinguish an accepted update from a worker actually receiving or acting on it. Queueing a follow-up and steering an active turn are different operations; the interface and tool result should report which occurred. Worker completion should wake coordination so the Dot can review and summarize the result without waiting for another user message.

## What the user's screenshots establish

The three supplied desktop screenshots are visual evidence for this requested interface, rather than evidence of OpenAI's private architecture:

- Selecting a named Dot opens its ongoing conversation. Its right panel contains identity, status, computers, recent activity and output files.
- Work continues and reports arrive in that same conversation. The screenshots include blocked-work updates; the user's later notification preference takes precedence over repeating those updates.
- Ordinary chats and work sessions are separate entries. The blank new-session screen has a centered Chat/Work selector; Work adds project, file, permission and model controls.
- The requested New chat action belongs in the upper-right corner. It creates an independent session, rather than another conversation for the selected Dot.

Call and Slack controls appear in the reference image. Voice was explicitly removed from the local scope, and messaging connectors have not been requested as implemented integrations. These controls should not imply capabilities that CIT does not provide.

## Comparison and implementation priorities

This table is an implementation contract and gap map, not an assertion that every row has already passed verification. Consult [architecture](architecture.md) and [verification](verification.md) for the shipped behavior and measured tests.

| Area                    | Evidence or requested behavior                                | CIT decision and verification target                                                                                                                         |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parent identity         | Named persistent Dot; user's ongoing main conversation        | Store identity independently of tasks and processes; reopen one canonical conversation after restart.                                                        |
| Pet                     | Public customization and pets; user requests a pet            | Keep editable original pet and name. Do not imply the full vendor pet editor exists.                                                                         |
| First Dot               | Public primary Dot is resettable                              | Retain the requested permanent, nondeletable primary Dot.                                                                                                    |
| Extra Dots              | Public launch describes future additions                      | Allow removable extra Dots now, with explicit owned-data cleanup.                                                                                            |
| Independent sessions    | User's Chat/Work screenshots and ownership request            | New chat selects Chat or Work; neither session acquires a Dot owner or its private memory.                                                                   |
| Parent tools            | User says Dot prompts workers instead of authoring code       | Give parent coordination tools; broker rejects parent file writes and command execution.                                                                     |
| Parent messages         | User requires conversational text                             | Keep code, patches, terminal output and raw worker transcripts out of the main conversation, including streaming and recovery.                               |
| Worker sessions         | Publicly separate conversations with scoped context           | Keep child transcripts and results inspectable in Activity; pass only relevant instructions and sources.                                                     |
| Worker roles            | User's Chat/Codex analogy                                     | Delegate general assistance/research, coding/execution and review to appropriate worker roles and configured models.                                         |
| Async dispatch          | User requests immediate receipt and later steering            | Support nonblocking delegation, status inspection and follow-up to the same owned session; accurately report accepted, queued, running and completed states. |
| Review and refinement   | Public Dot can check and instruct its own tasks               | Inspect evidence, then refine the owned task or create another bounded assignment. Preserve its environment and ownership.                                   |
| File handoff            | Public task files; user requests delivery only when asked     | Show output metadata in the side panel. Explicit forwarding attaches a downloadable file from an owned worker; never paste its source into the Dot reply.    |
| Background availability | Public work continues between interactions                    | Keep local services independent of the browser; work proceeds without a new user prompt while services and workstation run.                                  |
| Wakeups                 | Public agent-directed continuations separate from schedules   | Durable self-selected wakeups are a separate capability to implement and verify; existing saved schedules alone do not establish parity.                     |
| Schedules               | Public saved recurring work                                   | Store instructions, time zone, timing and notification policy; distinguish run cancellation from schedule cancellation.                                      |
| Proactive research      | Public read-only background research                          | Treat private research agents as a separate future mode; do not call unrestricted execution or idle polling the same feature.                                |
| Events                  | Public supported event monitoring                             | Add real connector event admission and deduplication before claiming event-driven monitoring.                                                                |
| Own computer            | Public persistent computer and human takeover                 | Preserve the real local graphical desktop. Automated graphical agent control remains a separate missing capability.                                          |
| Permissions             | Public delegated actions retain permissions                   | Enforce approved folders, owner boundaries and specific external-action approvals at the broker.                                                             |
| Memory                  | Public selected context and saved notes                       | Persist per-Dot memories; independently owned Chat/Work must not inherit them. CIT's editable memory UI is a local choice.                                   |
| Pause/stop              | Public parent, child and schedule controls differ             | Document CIT's current global pause and cancellation semantics; do not imply an identical vendor lifecycle.                                                  |
| Models                  | Public Dots use a vendor model; user requires local providers | Use swappable Ollama/LM Studio profiles with frozen in-flight selections. Model quality and GPU sizing require workstation tests.                            |

## Coordinator behavior to build and test

The desired local loop is:

1. Receive a user message, a saved goal's due event or an owned worker's result.
2. Relate it to the Dot's responsibilities and relevant saved context.
3. Speak directly for normal conversation. Delegate work that needs authored deliverables, coding or computer execution with a scoped prompt and success criteria.
4. Dispatch without waiting when useful. Let workers execute in their own sessions, inspect status and send follow-up instructions. Keep the parent conversation responsive while they run.
5. Review what the worker actually achieved. Request a correction or additional review when the result is incomplete; report uncertainty accurately.
6. Send a prose update only when there is meaningful progress or a decision. Forward selected worker files when the user asks.
7. Retain state and await the next relevant event. Add a durable continuation only when useful work requires another wakeup.

This is a local design derived from the documented coordination behavior and the user's instructions. It is not OpenAI's disclosed algorithm.

Acceptance scenarios should cover:

- A coding request leads to a worker task and an actual tested file change. The Dot reports the outcome without emitting code; the worker's own task remains inspectable.
- A worker returns a fenced code block, a patch or raw terminal output. Those bytes never stream into or become a result notification in the Dot's main conversation.
- A parent attempts file writing or command execution, including replay after restart. The broker rejects it; an independent Work task still executes its allowed tools.
- The user requests a worker's file. Its download contains the correct bytes, name and originating task. Another Dot's files and paths outside the permitted workspace cannot be forwarded.
- An unrelated worker completion does not automatically attach files. Unchanged scheduled results do not produce repeated pings.
- Nonblocking delegation returns before worker completion. Status inspection identifies the same task, and a follow-up reaches that existing worker session without creating a duplicate assignment. Worker completion triggers a parent review.
- A new priority can be supplied while a worker runs. The Dot remains available, retains the right task context and does not transfer unrelated permissions.
- Restart preserves the Dot identity, canonical conversation, worker lineage and pending state without duplicate delivery or blind execution replay.

## Muse comparison

Meta describes a persistent dedicated VM, background work after app closure, reviewable activity, connected services and approval for critical actions. Its free tier has a usage limit, with optional paid continuation. That supports the general persistent-agent concept but does not establish a locally hosted Ubuntu inference framework or a Dots-equivalent delegation protocol. [Muse](https://ai.meta.com/muse/)

## Source coverage and limitations

The research used twelve primary references: the linked OpenAI feature page, launch article, six Learn Dots chapters, two Help Center articles, enterprise local-access guide and system-card Dots appendix. Meta's page was checked separately. All OpenAI pages were readable through the web tool. Meta's direct page extraction returned no readable lines, so its official indexed text supplied the limited comparison. No account automation, authenticated product internals or vendor computer contents were inspected.

The documentation itself has release differences: Learn describes texting as coming soon, while Help describes a limited texting beta. The Help Reset summary and privacy FAQ also discuss deletion at different levels. Preserve those distinctions rather than infer a universal account behavior. Neither affects the user's text-only local scope.

The sources do not identify Dots' OS distribution, hypervisor, storage layout, queue implementation, wakeup algorithm, model prompts, context-selection algorithm or delegation wire protocol. The system card supplies technical behavior and evaluation context, not a blueprint for those components. Reproducing the visible coordination and interaction patterns is a concrete target; claiming an exact private implementation or equivalent capability for an untested local model would exceed the evidence.
