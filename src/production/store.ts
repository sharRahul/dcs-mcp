/** Immutable project/revision storage. Only staged directories are removed on failure. */
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,lstat,realpath,rm,rename,writeFile} from 'node:fs/promises';
import {projectSchema,revisionSchema,type Revision} from './schema.js';
export const sha256=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export async function readJson(file:string):Promise<any>{const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>16*1024*1024)throw new Error('Expected bounded regular JSON file');return JSON.parse(await readFile(file,'utf8'));}
export async function directory(dir:string){const st=await lstat(dir);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Expected a directory, not a symlink');return realpath(dir);}
export async function projectAt(dir:string){const root=await directory(dir);return {root,project:projectSchema.parse(await readJson(path.join(root,'project.json')))};}
export function revisionDir(root:string,number:number){if(!Number.isInteger(number)||number<1||number>9999)throw new Error('Revision must be 1..9999');return path.join(root,'revisions','r-'+String(number).padStart(4,'0'));}
export function missionFile(revision:Revision){return 'dcs-production-'+revision.id+'.miz';}
export async function revisionsAt(root:string){await directory(path.join(root,'revisions'));const names=(await readdir(path.join(root,'revisions'))).filter(n=>/^r-[0-9]{4}$/.test(n)).sort();
 const revisions:Revision[]=[];for(const name of names){const dir=await directory(path.join(root,'revisions',name));const r=revisionSchema.parse(await readJson(path.join(dir,'revision.json')));if(name!=='r-'+String(r.number).padStart(4,'0')||r.number!==revisions.length+1)throw new Error('Broken revision sequence');revisions.push(r);}return revisions;}
export async function revisionAt(dir:string,number:number){const {root,project}=await projectAt(dir);await directory(path.join(root,'revisions'));const folder=await directory(revisionDir(root,number));const revision=revisionSchema.parse(await readJson(path.join(folder,'revision.json')));
 if(revision.planDigest!==sha256(JSON.stringify(project.plan)))throw new Error('Production plan changed; create a new project to change acceptance criteria');
 if(revision.projectId!==project.id||revision.number!==number)throw new Error('Revision/project identity mismatch');
 const missionPath=path.join(folder,missionFile(revision));const st=await lstat(missionPath);if(!st.isFile()||st.isSymbolicLink()||st.size>512*1024*1024)throw new Error('Expected bounded regular mission file');
 if(sha256(await readFile(missionPath))!==revision.digest)throw new Error('Mission digest changed; save a new revision instead');return {root,project,folder,revision,missionPath};}
export async function withProjectLock<T>(root:string,action:()=>Promise<T>):Promise<T>{const lock=path.join(root,'.write-lock');try{await mkdir(lock);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Production project has another writer; retry after it finishes');throw e;}try{return await action();}finally{await rm(lock,{recursive:true});}}
export async function writeJson(file:string,data:unknown){const text=JSON.stringify(data,null,2)+'\n';if(Buffer.byteLength(text)>16*1024*1024)throw new Error('Production JSON artifact exceeds 16 MiB');await writeFile(file,text,{flag:'wx'});}
export async function appendRecord(folder:string,kind:'checks'|'evidence',data:unknown){await directory(folder);const dir=path.join(folder,kind);await directory(dir);const name=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.json';await writeJson(path.join(dir,name),data);return path.join(dir,name);}
export async function recordsAt(folder:string,kind:'checks'|'evidence'){const dir=await directory(path.join(folder,kind));const files=(await readdir(dir)).filter(n=>/^[0-9TZ-]+-[0-9a-f-]+\.json$/.test(n)).sort();if(files.length>10000)throw new Error('Too many production evidence records');return Promise.all(files.map(f=>readJson(path.join(dir,f))));}
export async function stagedRevision<T>(root:string,number:number,action:(stage:string)=>Promise<T>){const parent=await directory(path.join(root,'revisions'));const stage=path.join(parent,'.staging-'+randomUUID());await mkdir(stage);try{const result=await action(stage);await rename(stage,revisionDir(root,number));return result;}catch(e){await rm(stage,{recursive:true,force:true});throw e;}}
