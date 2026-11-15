// ABOUTME: Собирает готовый Workflow bundle в build-поставку компонента.
// ABOUTME: Runtime не скачивает SDK и не компилирует workflow при запуске.
import {bundleWorkflowCode} from "@temporalio/worker";
import {writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL("./verification-workflows.js",import.meta.url))});
await writeFile(new URL("./verification-workflow-bundle.cjs",import.meta.url),code);
