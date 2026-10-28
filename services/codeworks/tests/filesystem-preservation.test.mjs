// ABOUTME: Проверяет nofollow snapshot файлов, которые Git может игнорировать.
// ABOUTME: Использует только временные файлы; не обращается к рабочим данным или архивам.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {snapshotPreservedTree,verifyFilesystemPreservation} from '../src/filesystem-preservation.mjs';

test('snapshot detects content, file addition, removal, mode and symlink changes',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'preserve-snapshot-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(root+'/tmp');await mkdir(root+'/tmp/sub');await writeFile(root+'/tmp/sub/file','original');await symlink('sub/file',root+'/tmp/link');
 const original=await snapshotPreservedTree(root,'tmp');assert.deepEqual(await snapshotPreservedTree(root,'tmp'),original);
 await writeFile(root+'/tmp/sub/file','changed');assert.notEqual((await snapshotPreservedTree(root,'tmp')).sha256,original.sha256);await writeFile(root+'/tmp/sub/file','original');
 await chmod(root+'/tmp/sub/file',0o700);assert.notEqual((await snapshotPreservedTree(root,'tmp')).sha256,original.sha256);await chmod(root+'/tmp/sub/file',0o644);
 await writeFile(root+'/tmp/extra','new');assert.notEqual((await snapshotPreservedTree(root,'tmp')).sha256,original.sha256);await rm(root+'/tmp/extra');
 await rm(root+'/tmp/link');await symlink('other',root+'/tmp/link');assert.notEqual((await snapshotPreservedTree(root,'tmp')).sha256,original.sha256);
 await rm(root+'/tmp/sub/file');assert.notEqual((await snapshotPreservedTree(root,'tmp')).sha256,original.sha256);
});

test('snapshot refuses symlink source, missing tree and traversal',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'preserve-nofollow-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(root+'/actual');await symlink('actual',root+'/link');
 await assert.rejects(snapshotPreservedTree(root,'link'),{code:'TARGET_CHANGED'});
 await assert.rejects(snapshotPreservedTree(root,'missing'),{code:'TARGET_CHANGED'});
 await assert.rejects(snapshotPreservedTree(root,'../actual'),{code:'TARGET_CHANGED'});
 await assert.rejects(verifyFilesystemPreservation({id:'p'},{id:'w',path:root},{receipt_path:root+'/receipt',receipt_sha256:'0'.repeat(64)}),{code:'TARGET_CHANGED'});
});
