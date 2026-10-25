// ABOUTME: Собирает workflow заранее тем же SDK, который попадёт в immutable поставку.
// ABOUTME: Runtime загружает dist bundle и не ищет исходники или webpack на сервере.
import {bundleWorkflowCode} from '@temporalio/worker';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const output=new URL('../dist/',import.meta.url);
await mkdir(output,{recursive:true});
const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./workflows.cjs',import.meta.url))});
await writeFile(new URL('workflows.js',output),code);
