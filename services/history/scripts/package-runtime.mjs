// ABOUTME: Packages the prebuilt history runtime through the Codeworks owner descriptor.
// ABOUTME: Copies only locked runtime dependencies; never compiles or installs packages.
import {resolve} from 'node:path';
import {discover} from '../../codeworks/components/graph.mjs';
import {packageComponent} from '../../codeworks/components/package-runtime.mjs';
const root=resolve(import.meta.dirname,'../../..');
try {
 const args=process.argv.slice(2);
 if(args.length && (args.length!==2 || args[0]!=='--output')) throw Error('USAGE: package-runtime.mjs [--output tmp/<output-root>]');
 const component=discover(root).components.get('history');
 const artifact=await packageComponent(root,component,args[1]??'tmp/history-runtime');
 console.log(artifact.path);
} catch(error) {console.error(error.message);process.exitCode=1;}
