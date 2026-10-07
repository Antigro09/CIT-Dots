import { eveChannel } from "eve/channels/eve";
import { timingSafeEqual } from "node:crypto";
import { internalToken } from "../../src/server/config";

export default eveChannel({
  auth: (request: Request) => {
    const presented =
      request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
    const expected = internalToken();
    const taskId = request.headers.get("x-cit-task-id");
    if (!taskId || !/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) return null;
    const suppliedBytes = Buffer.from(presented);
    const expectedBytes = Buffer.from(expected);
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    )
      return null;
    return {
      authenticator: "cit-broker",
      principalId: taskId,
      principalType: "service",
      attributes: { taskId },
    };
  },
  turnPolicy: "queue",
});
