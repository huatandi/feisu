'use strict';
// Starts the real server against a disposable copy, never the user's history folder.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{once}=require('node:events');
test('local server delivers every dependency, supports HEAD, and protects private files',async()=>{
 const root=path.join(__dirname,'..'),tmp=await fs.mkdtemp(path.join(os.tmpdir(),'feisu-r6-http-'));let child;
 try{
  for(const name of ['local-server.cjs','index.html','js','css','vendor','assets'])await fs.cp(path.join(root,name),path.join(tmp,name),{recursive:true});
  await fs.mkdir(path.join(tmp,'.git'));await fs.writeFile(path.join(tmp,'.git','config'),'PRIVATE');
  child=spawn(process.execPath,[path.join(tmp,'local-server.cjs')],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server did not start (is port 18749 occupied?)')),5000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(Error('Server exited before startup'));});child.stdout.on('data',d=>{if(d.toString().includes('FEISU:')){clearTimeout(timer);resolve();}});});
  const base='http://127.0.0.1:18749',html=await (await fetch(base)).text();assert.match(html,/v5\.0\.5 · 框内识别版 R11/);
  const localPaths=[...html.matchAll(/(?:src|href)="\.\/([^"?]+)(\?[^\"]*)?"/g)].map(m=>'/'+m[1]+(m[2]||''));
  for(const route of localPaths){const r=await fetch(base+route);assert.equal(r.status,200,route);assert.ok((await r.arrayBuffer()).byteLength>0,route);if(route.includes('.js'))assert.match(r.headers.get('content-type'),/javascript/,route);}
  const head=await fetch(base+'/vendor/exceljs-4.4.0.min.js',{method:'HEAD'});assert.equal(head.status,200);assert.ok(Number(head.headers.get('content-length'))>0);assert.equal((await head.arrayBuffer()).byteLength,0);
  const post=await fetch(base+'/index.html',{method:'POST'});assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET, HEAD');
  for(const route of ['/.git/config','/飞速盘点历史记录/current.json','/tests/local-server.cjs','/install-r6.ps1'])assert.equal((await fetch(base+route)).status,404,route);
  const api=await fetch(base+'/api/history');assert.equal(api.status,200);assert.deepEqual((await api.json()).records,[]);
  console.log('Verified '+localPaths.length+' HTML dependencies, HEAD, method rejection, private-file isolation, and empty history API');
 }finally{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}await fs.rm(tmp,{recursive:true,force:true});}
});
