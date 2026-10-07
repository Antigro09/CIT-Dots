# CIT Dots implementation contract

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
