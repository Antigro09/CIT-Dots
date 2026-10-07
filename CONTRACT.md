# CIT Dots implementation contract

## Persistent dots and graphical computers (October 2026 update)

The user selected a **full graphical Linux desktop**, not a simulated desktop dashboard. Implement a real isolated Ubuntu/Xfce desktop streamed with TigerVNC/noVNC, with a browser, terminal and file manager. Each Dot owns persistent computer files; shutting the desktop down does not delete the Dot or its files. All computers and model inference run locally while the workstation is awake.

- `PRIMARY_DOT_ID = "dot-primary"`. Store creates this Dot once and migrates legacy records to it. The first Dot cannot be removed or have its primary status changed, including through generic store methods. Extra Dots can be added and removed.
- `Dot`: BaseRecord + `name: string`, `personality: string`, `avatar: {kind: "blob" | "cat" | "dog" | "robot", color: string}`, `isPrimary: boolean`, `modelProfileId: string | null`. Color is a validated six-digit hex color; names/personality are bounded plain text.
- `dotId` on Session, Task, Goal, Memory, InboxItem. All new broker records supply it; legacy records migrate to the primary Dot. Read interfaces can allow an optional field for older authored fixtures, but runtime ownership always resolves to a stored Dot. Child tasks inherit the parent's Dot and cannot cross sessions/Dots.
- `Snapshot.dots: Dot[]`; `Settings.selectedDotId?: string`, `Settings.desktopImage?: string`. Defaults are primary Dot and `cit-dots-desktop:latest`. Models/projects remain shared, while sessions/tasks/goals/memories/inbox are Dot-specific. Model profile assigned to a Dot is its default for new tasks.
- `POST /dots` accepts name/personality/avatar/modelProfileId; `PATCH /dots/:id` changes those fields only. `DELETE /dots/:id` refuses primary, cancels extra Dot work, stops its computer, then removes its owned records/files without touching original host projects. Selected Dot falls back to primary. Changing selectedDotId is validated against existing Dots.
- Sessions, task and goal creation accept optional dotId. If a session/parent is supplied, its owner is authoritative and conflicting dotId is rejected. Memory creation uses explicit dotId or selectedDotId; memory ownership cannot change during edits. Worker context includes Dot name/personality and only that Dot's memories.
- Private computer root: `.cit-data/dots/<dotId>/computer/{home,workspace,artifacts}`. Metadata/desktop passwords live **outside** the computer mount. IDs are validated, parent directories cannot be symlinks, and mounts come only from trusted broker lookups. `ensureComputer(dataDir,dotId)` returns `{dotId,root,home,workspace,artifacts}`. `createComputerWorkspace(dataDir,dotId,taskId)` returns a Workspace with `scope: "computer"`, `computerRoot`, `dotId`; file tools work there without registering a host project. Project workspace clones retain existing diff/apply semantics and gain the trusted computerRoot for HOME/cache persistence. Applying a computer workspace to a host project is refused.
- Runner mounts only its workspace and that Dot's computer; HOME points into its own home. All workers for one Dot share a computer lock, and different Dots never receive one another's mounts. Existing exact-command network approval remains unchanged.
- `DesktopManager` in `src/server/desktops.ts`, constructed with dataDir/image. `status(dotId)`, `start(dotId)`, `stop(dotId)`, `remove(dotId)` return `DesktopStatus`: `{dotId, state: "stopped" | "starting" | "running" | "error", url: string | null, os: "Ubuntu 26.04", error?: string}`. Running URL embeds noVNC with generated per-Dot VNC password and remote resize; it is only returned to the local GUI, never to the model or logs. Its stored metadata is outside guest mounts.
- Each desktop uses its own Docker **internal network** (no outbound internet), localhost-only published noVNC port, no host Docker socket/devices, dropped capabilities, no-new-privileges, resource limits and non-root guest user. Guest writable HOME/workspace persist, OS image shared/read-only with temporary runtime directories. Container/network ownership labels must match before attach/removal. After broker restart inspect and reattach existing owned desktop rather than spawning duplicates. Graphical desktops stay independent of closing the GUI.
- `GET /dots/:id/computer` returns `{dotId, desktop: DesktopStatus}`. `POST /dots/:id/computer/start|stop` control the desktop. `GET /dots/:id/computer/files?path=...` returns `{files: Array<{path:string,type:"file"|"directory",size?:number}>}`; `GET /dots/:id/computer/file?path=...` returns `{path,content}`; `PUT /dots/:id/computer/file` accepts `{path,content}`. These paths are relative to the private workspace, bounded and symlink-safe. File APIs support checking real persistence; the primary view is the interactive desktop.
- UI: original animated SVG pet; permanent primary indicator; add/rename/personality/appearance/model/remove extra Dot; selected Dot filters its work and conversations; `/dots` home and `/computer` with genuine interactive noVNC iframe, explicit start/stop/reconnect and real state/error/setup instructions. Loading/offline states must not show a fake live desktop. Use existing theme/responsiveness and reduced-motion preferences.

### User screenshot and independent sessions

The user's selected-Dot screenshot shows its persistent conversation in the center and a right identity card with pet/name, computer status, recent activity and actual output files. Use this layout for selected-Dot conversation; omit voice/Slack controls because neither is requested. The user additionally requires ordinary ChatGPT/Claude-style chat and coding/work sessions **without a Dot**.

- Session gains optional `kind: "dot" | "chat" | "work"`; `dotId` on Session/Task/Goal/Memory/InboxItem is optional **string | null**. Missing legacy fields migrate to primary Dot; explicit null means independent and must remain null through migration/restarts.
- `POST /sessions` accepts kind. `kind: "chat" | "work"` creates independent `dotId: null`; rejects an explicitly non-null dotId. `kind: "dot"` (legacy default) uses its specified/selected Dot. A work session uses coder role for new message tasks. Independent chat uses selected local model and global general context; it cannot access any Dot's personal memories/computer. Independent work uses its approved project workspace and existing approval rules.
- Each Dot can have a stable `sessionId?: string` for its main conversation. `GET /dots/:id/session` returns/creates that persistent main Session, title based on Dot name, kind dot, owned by that Dot. Child/worker sessions remain separate. This endpoint does not need a configured model merely to open a Dot.
- Sidebar has distinct New chat/New work session actions and ordinary recent sessions; Dot selection opens the main Dot conversation. Keep customization accessible from the identity card/home. Selecting a standalone session must not silently transfer it into a Dot or give it a Dot pet/name/context. Standalone sessions and host projects survive removal of an extra Dot.

Ownership during parallel implementation: storage agent owns shared/types.ts + store.ts + store tests; coding-tools agent owns computers.ts + workspaces.ts + runner.ts + computer tests; runtime-architecture agent owns desktops.ts + desktop image/scripts + desktop tests; GUI agent owns app routes/components/dots/CSS; root owns broker.ts/api.ts/contract and coordination; integration agent owns new cross-layer Dot tests; research/docs agent owns official research note and documentation updates.

Approved first release: text chat, coding, nested workers, goals/schedules, local memory, proactive progress/results/questions, GUI-close persistence. No voice. Ollama and LM Studio. Automatic approved project work; approval for network/external changes. Single local user.

## Processes and configuration

- Next GUI: `http://127.0.0.1:3000`, `npm run dev:web` / `npm run start:web`.
- Control service: `http://127.0.0.1:4318`, `npm run dev:broker` / `npm run start:broker`.
- Eve worker: `http://127.0.0.1:4319`, `npm run dev:eve` / `npm run start:eve`.
- `npm run dev` starts all three. `npm run build` builds Eve then Next; broker uses tsx (Node24).
- `CIT_DATA_DIR` default `.cit-data` under project root. SQLite `cit.sqlite`; workspaces under `workspaces/`. Eve `.eve/.workflow-data` also persists.
- `CIT_CONTROL_URL`, `CIT_EVE_URL` override loopback ports. `CIT_INTERNAL_TOKEN` optional: default shared token read/create `CIT_DATA_DIR/internal-token` mode0600 (root implements src/server/config.ts export config and internalToken()). Never send this token to browser/model.
- Notifications poll `GET /api/local/inbox?undelivered=1`; bridge ACK `POST /api/local/inbox/:id/delivered`. Inbox read state is separate `POST /api/local/inbox/:id/read`.

## Shared records (src/shared/types.ts)

All have string id, createdAt/updatedAt ISO strings (Store fills if missing), version number optional. camelCase. Nullable relationships use null.

- ModelProfile: {id,name,provider:'ollama'|'lmstudio',baseUrl,modelId,contextWindow:number,maxOutputTokens:number,temperature:number,capabilities?:{streaming:boolean,tools:boolean},lastCheckedAt?:string,status?:'unknown'|'ready'|'error',error?:string}
- Project: {id,name,path,isGit:boolean}
- Session: {id,title,projectId:string|null,modelProfileId:string|null}
- Message: {id,sessionId,role:'user'|'assistant'|'system'|'tool',content,taskId?:string|null,kind?:'chat'|'progress'|'result'|'question'|'error',attachments?:{name,content}[]}
- Task: {id,sessionId,parentId:string|null,rootId,role:'coordinator'|'coder'|'investigator'|'reviewer',title,prompt,projectId:string|null,modelProfileId:string,profileSnapshot:ModelProfile,status:'queued'|'running'|'waiting_approval'|'waiting_child'|'completed'|'failed'|'canceled'|'interrupted',depth:number,eveSessionId?:string,workspace?:Workspace,result?:string,error?:string,tokenUsage?:number,toolCount?:number,steps?:number,goalId?:string|null,occurrence?:string|null,cursor?:number,deadlineAt?:string}
- Workspace: standalone tools agent defines and exports interface; shared types can use `import type` from workspaces or structural generic record initially, then align.
- Goal: {id,title,objective,sessionId,projectId:string|null,modelProfileId:string,scheduleType:'once'|'interval'|'cron',intervalMinutes?:number,cron?:string,timezone:string,nextRunAt:string,enabled:boolean,overlap:'skip'|'queue',lastRunAt?:string,lastTaskId?:string}
- Memory: {id,title,content,source?:string}
- Approval: {id,taskId,toolName,input:Record<string,unknown>,description,status:'pending'|'approved'|'denied',operationId:string,decisionAt?:string}
- InboxItem: {id,sessionId,taskId?,messageId?,title,body,kind:'progress'|'result'|'question'|'error',read:boolean,delivered:boolean}
- Event: {id:number,type:string,data:unknown,createdAt:string,taskId?:string|null}
- Settings: {paused:boolean,defaultModelProfileId:string|null,maxActiveTasks:number,maxConcurrentInference:number,maxDepth:number,maxSteps:number,maxToolCalls:number,maxRunMinutes:number,maxTokensPerGoal:number,sandboxImage:string,theme:'dark'|'light'|'system'}
- ToolOperation: {id,taskId,toolName,input,status:'pending'|'running'|'awaiting_approval'|'completed'|'failed'|'unknown',result?,error?,approvalId?}

## Store interface (storage agent owns)

`new Store(path)`, get<T>(table,id), list<T>(table,{limit?,order?,predicate?}), insert<T>(table,record), update<T>(table,id,patchOrUpdater), remove(table,id), transaction(fn), getSetting/setSetting, addMessage(sessionId,message), messages(sessionId), event(type,data,taskId?), events(afterCursor), claimOccurrence(goalId,scheduledAt,taskId), getVersionedKV/compareAndSetKV, close().

Table names: models, projects, sessions, messages, tasks, goals, memories, approvals, inbox, tool_operations. Root supplies Settings defaults. Store supports metadata defaults and optimistic CAS where useful.

## GUI API (all JSON, Next proxies /api/local/* to broker)

- GET `/api/local/snapshot`: {sessions,models,projects,tasks,goals,memories,approvals,inbox,settings,health:{broker:boolean,eve:boolean,docker:boolean},eventsCursor:number}
- GET `/api/local/events?after=N`: SSE persisted events `{id,type,data}`. GUI may refresh snapshot on events; poll fallback.
- POST `/api/local/sessions`: {title?,projectId?,modelProfileId?} -> Session
- GET `/api/local/sessions/:id`: {session,messages,tasks}
- POST `/api/local/sessions/:id/messages`: {content,attachments?:{name,content}[],modelProfileId?} -> {message,task}. Creating a user turn creates coordinator task; previous transcript supplied to model. Reject empty/oversized input.
- POST `/api/local/tasks`: {sessionId?,prompt,role?,projectId?,modelProfileId?,title?} -> Task
- GET `/api/local/tasks/:id`: {task,children,operations,diff?}
- POST `/api/local/tasks/:id/cancel`: {} -> Task
- POST `/api/local/tasks/:id/retry`: {} -> new Task
- GET `/api/local/tasks/:id/diff`: {patch,files}
- POST `/api/local/tasks/:id/apply`: {} -> result (explicit user's review action)
- POST `/api/local/projects`: {path,name?} -> Project
- DELETE `/api/local/projects/:id`: unregister only; retains files
- POST `/api/local/models`: ModelProfile minus id -> ModelProfile
- PATCH `/api/local/models/:id`: partial ModelProfile -> ModelProfile
- DELETE `/api/local/models/:id`: delete if not running
- POST `/api/local/models/:id/probe`: {} -> ModelProfile
- POST `/api/local/model-discovery`: {provider,baseUrl} -> {models:{id:string}[]}
- POST `/api/local/goals`: Goal minus id/sessionId (optional sessionId) -> Goal
- PATCH `/api/local/goals/:id`: partial Goal -> Goal
- DELETE `/api/local/goals/:id`
- POST `/api/local/goals/:id/run`: {} -> Task
- POST `/api/local/memories`: {title,content,source?} -> Memory
- PATCH `/api/local/memories/:id`: partial Memory -> Memory
- DELETE `/api/local/memories/:id`
- PATCH `/api/local/settings`: partial Settings -> Settings
- POST `/api/local/approvals/:id/decide`: {decision:'approve'|'deny'} -> Approval
- GET `/api/local/inbox`, POST `/api/local/inbox/:id/read`, POST `/api/local/inbox/:id/delivered`
- Errors non2xx {error:string}. UI must show real errors.

## Trusted Eve worker API (bearer internal token)

- GET `/api/internal/worker-context?taskId=...` -> {taskId,role,instructions:string,model:{modelId,baseUrl,contextWindow,maxOutputTokens,temperature},messages:{role,content}[],memory:string}. baseUrl points to broker `/api/internal/model/:taskId/v1`, not physical provider. Provider requests carry bearer internal token; model never sees it.
- POST `/api/internal/tool`: {taskId,sessionId?,callId,toolName,input} -> {result} | {approval:{id,prompt}} | {childTaskId}. Names: list_files, read_file, write_file, run_command, delegate, report_progress, remember, ask_user.
- GET `/api/internal/tool-result?taskId=...&callId=...` -> {status:'pending'|'completed'|'denied'|'failed',result?,error?}. Durable tool should poll or park+hook; root resumes approval externally once decision stored. Agents never get shell or direct network bypass tools.
- GET `/api/internal/children/:id` -> {status,result?,error?}
- Model router POST `/api/internal/model/:taskId/v1/chat/completions`: OpenAI-compatible request/response, streaming passes through with accounting; root owns.

Eve wrapper exports `createWorkerSession(taskId):Promise<string>`, `sendWorkerMessage(sessionId,taskId,message):Promise<void>`, `streamWorkerSession(sessionId,taskId,after?,signal?):AsyncIterable<WorkerEvent>`, `cancelWorkerSession(sessionId,taskId):Promise<void>`, `workerHealth():Promise<boolean>`.
WorkerEvent root contract: {type:'text'|'tool'|'completed'|'failed'|'waiting'|'usage',text?:string,error?:string,input?:unknown,result?:unknown,usage?:{inputTokens:number,outputTokens:number},cursor?:number}. `text` incremental chunks, `completed` definitive turn completion, not arbitrary SSE closure. Recover stream cursor persisted.

## Workspace/runner exports (tools agent owns)

registerProject(path), createWorkspace(projectPath,taskId,dataDir), listFiles(workspace,relativePath?), readFile(workspace,path), writeFile(workspace,path,content), workspaceDiff(workspace)->{patch,files}, applyWorkspace(workspace)->{files}; runCommand({workspace,command,signal,timeoutMs,networkApproval?})->{exitCode,stdout,stderr,timedOut,canceled}. Persist Workspace with root/path and original project path. Root passes operationId where available. No unsafe host execution except explicit CIT_TEST_HOST_RUNNER=1 test-only switch.

## Verification

node --import tsx --test tests/*.test.ts. Deterministic local OpenAI server for meaningful integration; never register fake/demo data in default DB. Playwright screenshots of actual running GUI; screenshot-only seeded fixture lives in separate test temp DB, marked test in docs. Root commits and pushes after all checks.
