import http from 'node:http';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {beginSolve,getNode,solverInput} from './lib/solver.mjs';
import {range,cards,validState,cardText,riverSensitivity} from './lib/poker.mjs';
import {createProAPI} from './lib/pro-server.mjs';
import {createAcceleratorStatus} from './lib/hardware.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url)),PORT=Number(process.env.POKERLAB_PORT)||8731;
const python=process.env.POKERLAB_PYTHON||(process.env.POKERLAB_PYTHON||'python');
fs.mkdirSync(path.join(ROOT,'data','cases'),{recursive:true});fs.mkdirSync(path.join(ROOT,'data','solves'),{recursive:true});
const acceleratorStatus=createAcceleratorStatus();
const jobs=new Map();let analyzing=false;const activeWorkers=new Set();
const json=(res,obj,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
const body=(req,maxBytes=4*1024*1024)=>new Promise((resolve,reject)=>{const chunks=[];let bytes=0,done=false;req.on('data',b=>{if(done)return;bytes+=b.length;if(bytes>maxBytes){done=true;reject(Error('输入文件过大（上限 '+Math.round(maxBytes/1024/1024)+' MB）。'));return;}chunks.push(b);});req.on('end',()=>{if(done)return;done=true;try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(Error('JSON 格式错误。'));}});req.on('error',reject);});
const idOK=id=>/^[a-f0-9-]{36}$/.test(id);
const professional=createProAPI({root:ROOT,json,body,onShutdown:()=>shutdown()});
const markLegacy=j=>{if(j.status==='complete'&&j.engineVersion!=='1.1.0-joint-chance'&&cards(j.state?.board||'').length<5)return {...j,status:'outdated',error:'旧版未来发牌概率计算已经修复。这份旧策略没有重新计算，请在新版研究台重新求解。'};return j;};
const getJob=id=>{if(!idOK(id))throw Error('无效记录编号。');const found=jobs.get(id);if(found)return markLegacy(found.job);const f=path.join(ROOT,'data','solves',id,'job.json');if(!fs.existsSync(f))throw Error('找不到求解记录。');return markLegacy(JSON.parse(fs.readFileSync(f)));};
const server=http.createServer(async(req,res)=>{try{
  if(!['127.0.0.1:'+PORT,'localhost:'+PORT].includes(req.headers.host)){return json(res,{error:'Host not allowed'},403);}
  if(req.method!=='GET'&&req.headers.origin&&!['http://127.0.0.1:'+PORT,'http://localhost:'+PORT].includes(req.headers.origin))return json(res,{error:'Origin not allowed'},403);
  const u=new URL(req.url,'http://127.0.0.1:'+PORT),p=u.pathname;
  if(await professional.handler(req,res,u))return;
  if(p==='/api/status')return json(res,{app:'PokerLab',brand:'观局 · RangeMind',accelerator:await acceleratorStatus(),version:'0.3.0',cpu:os.cpus()[0]?.model,threads:os.cpus().length,memoryGB:Math.round(os.totalmem()/2**30),gpuKernel:fs.existsSync(path.join(ROOT,'lib','equity.ptx')),solver:fs.existsSync(path.join(ROOT,'engines','TexasSolverCPU','console_solver.exe')),gpuSolverInstalled:fs.existsSync(path.join(ROOT,'engines','TexasSolverGPU','TexasSolverGpu.exe')),scope:'多人范围研究、河牌策略与转牌→河牌训练',port:PORT});
  if(p==='/api/range'&&req.method==='POST'){const s=await body(req);return json(res,range(s.range,cards(s.dead??'')));}
  if(p==='/api/sensitivity'&&req.method==='POST')return json(res,riverSensitivity(await body(req)));
  if(p==='/api/analyze'&&req.method==='POST'){
    const state=await body(req);validState(state);if(analyzing)return json(res,{error:'当前计算尚未完成。'},409);analyzing=true;
    const w=new Worker(new URL('./lib/analyze-worker.mjs',import.meta.url),{workerData:{state,python}});activeWorkers.add(w);const timer=setTimeout(()=>w.terminate(),90000);let sent=false;
    w.on('message',m=>{sent=true;if(m.ok)json(res,m.result);else json(res,{error:m.error},400);});w.on('error',e=>{if(!sent){sent=true;json(res,{error:e.message},500);}});w.on('exit',()=>{clearTimeout(timer);activeWorkers.delete(w);analyzing=false;if(!sent)json(res,{error:'计算超时，请减少样本或检查 GPU。'},500);});return;
  }
  if(p==='/api/cases'&&req.method==='GET'){const files=fs.readdirSync(path.join(ROOT,'data','cases')).filter(x=>x.endsWith('.json'));return json(res,files.map(f=>JSON.parse(fs.readFileSync(path.join(ROOT,'data','cases',f)))).sort((a,b)=>b.savedAt.localeCompare(a.savedAt)));}
  if(p==='/api/cases'&&req.method==='POST'){const b=await body(req);validState(b.state);const id=crypto.randomUUID(),item={id,title:String(b.title||'未命名研究').slice(0,100),notes:String(b.notes||'').slice(0,10000),state:b.state,result:b.result??null,savedAt:new Date().toISOString()};fs.writeFileSync(path.join(ROOT,'data','cases',id+'.json'),JSON.stringify(item,null,2));return json(res,item);}
  if(p==='/api/solve'&&req.method==='POST'){const s=await body(req);solverInput(s,'test.json');if([...jobs.values()].some(x=>x.job.status==='running'))return json(res,{error:'已有求解任务正在运行。'},409);const {job,stop}=beginSolve(ROOT,s,()=>{});jobs.set(job.id,{job,stop});return json(res,job);}
  if(p==='/api/solves'&&req.method==='GET'){const stored=fs.readdirSync(path.join(ROOT,'data','solves')).filter(id=>idOK(id)&&fs.existsSync(path.join(ROOT,'data','solves',id,'job.json'))).map(getJob);const byID=new Map(stored.map(j=>[j.id,j]));for(const {job} of jobs.values())byID.set(job.id,job);return json(res,[...byID.values()].sort((a,b)=>b.startedAt-a.startedAt));}
  if(p==='/api/solve/status')return json(res,getJob(u.searchParams.get('id')));
  if(p==='/api/solve/cancel'&&req.method==='POST'){const {id}=await body(req);jobs.get(id)?.stop();return json(res,{ok:true});}
  if(p==='/api/solve/node'&&req.method==='POST'){const {id,nodePath=[]}=await body(req),j=getJob(id);if(j.status!=='complete')throw Error(j.error||'求解未完成。');const tree=JSON.parse(fs.readFileSync(path.join(ROOT,'data','solves',id,'result.json')));return json(res,getNode(tree,j.state,nodePath));}
  if(p==='/api/solve/download'){const j=getJob(u.searchParams.get('id'));if(j.status!=='complete')throw Error(j.error||'求解未完成。');res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="solver-result.json"'});fs.createReadStream(path.join(ROOT,'data','solves',j.id,'result.json')).pipe(res);return;}
  if(p==='/api/presets')return json(res,[]); // Proprietary presets are excluded.
  if(p.startsWith('/api/'))return json(res,{error:'未知接口。'},404);
  const staticPaths={'/pro/research-lab.js':'public/pro/research-lab.js','/':'public/pro/index.html','/legacy':'public/index.html','/pro/app.js':'public/pro/app.js','/pro/inbox.js':'public/pro/inbox.js','/pro/ranges.js':'public/pro/ranges.js','/pro/play.js':'public/pro/play.js','/pro/range-construction.js':'public/pro/range-construction.js','/pro/study-projects.js':'public/pro/study-projects.js','/pro/lab-common.js':'public/pro/lab-common.js','/pro/lab.css':'public/pro/lab.css','/pro/runout-plan.js':'public/pro/runout-plan.js','/pro/balance-examples.js':'public/pro/balance-examples.js','/pro/response-witness.js':'public/pro/response-witness.js','/pro/live-recorder.js':'public/pro/live-recorder.js','/pro/sensitivity-debrief.js':'public/pro/sensitivity-debrief.js','/pro/style.css':'public/pro/style.css','/app.js':'public/app.js','/style.css':'public/style.css','/poker.mjs':'lib/poker.mjs','/research':'docs/guide.html','/research/source':'docs/REPORT.md','/research/validation':'docs/verification-summary.json'};if(process.env.POKERLAB_RESEARCH_ROOT){for(const [route,name] of [['/research','研究与教学设计.html'],['/research/source','专业训练体系与产品蓝图.md'],['/research/validation','教学实验核验.json']])staticPaths[route]=path.join(process.env.POKERLAB_RESEARCH_ROOT,name);}const f=staticPaths[p];if(!f||!fs.existsSync(path.resolve(ROOT,f)))return json(res,{error:'Not found'},404);
  const scriptHashes=p==='/research'?[...fs.readFileSync(path.resolve(ROOT,f),'utf8').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>"'sha256-"+createHash('sha256').update(m[1]).digest('base64')+"'").join(' '):'';
  res.writeHead(200,{'Content-Type':p==='/research/source'?'text/plain; charset=utf-8':p==='/research/validation'?'application/json; charset=utf-8':p.endsWith('.css')?'text/css; charset=utf-8':p.endsWith('.js')||p.endsWith('.mjs')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' ${scriptHashes}; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`});fs.createReadStream(path.resolve(ROOT,f)).pipe(res);
}catch(e){json(res,{error:e.message},400);}});
server.listen(PORT,'127.0.0.1',()=>console.log(`PokerLab http://127.0.0.1:${PORT}`));
let shuttingDown=false;
const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;const cleanup=professional.shutdown();for(const {stop} of jobs.values())stop();for(const w of activeWorkers)w.terminate();await cleanup;server.close(()=>process.exit());};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
