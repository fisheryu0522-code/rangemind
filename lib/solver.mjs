import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {validState,cardText,cards,range} from './poker.mjs';
function serializeRange(r,board){
  const groups=new Map();for(const c of r.live){if(!groups.has(c.hand))groups.set(c.hand,[]);groups.get(c.hand).push(c);}
  return [...groups].flatMap(([hand,cs])=>{const full=range(hand,board).live;return full.length===cs.length&&cs.every(c=>Math.abs(c.weight-cs[0].weight)<1e-12)?[hand+':'+cs[0].weight]:cs.map(c=>c.label+':'+c.weight);}).join(',');
}
export function solverInput(state,output){
  const v=validState(state);if(v.rake!==0)throw Error('当前接入的 CPU 求解器只验证了无抽水模型。将抽水设为 0 后求解；请勿将结果当成 GG 抽水局的精确答案。');
  if(!v.stack)throw Error('有效筹码需大于 0。');
  const sizes=String(state.sizes||'50').split(',').map(Number);if(!sizes.length||sizes.length>3||sizes.some(x=>!Number.isFinite(x)||x<=0||x>500))throw Error('下注尺寸填 1–3 个百分比数字，例如 33,75。');
  const threads=Math.min(24,Math.max(1,Number(state.threads)||12))|0,iterations=Math.min(5000,Math.max(50,Number(state.iterations)||500))|0,accuracy=Math.min(5,Math.max(.05,Number(state.accuracy)||.5));
  const lines=[`set_pot ${v.pot}`,`set_effective_stack ${v.stack}`,`set_board ${v.board.map(cardText).join(',')}`,`set_range_oop ${serializeRange(v.oop,v.board)}`,`set_range_ip ${serializeRange(v.ip,v.board)}`];
  for(const seat of ['oop','ip'])for(const street of ['flop','turn','river']){lines.push(`set_bet_sizes ${seat},${street},bet,${sizes.join(',')}`,`set_bet_sizes ${seat},${street},raise,60`,`set_bet_sizes ${seat},${street},allin`);}
  lines.push('set_allin_threshold 0.67','build_tree',`set_thread_num ${threads}`,`set_accuracy ${accuracy}`,`set_max_iteration ${iterations}`,'set_print_interval 10','set_use_isomorphism 1','start_solve','set_dump_rounds 1',`dump_result ${output.replaceAll('\\','/')}`);
  return {text:lines.join('\n')+'\n',settings:{threads,iterations,accuracy,sizes,rake:0,raiseSize:60,allinThreshold:.67,dumpRounds:1,scope:'当前街的行动树；后续街参与求解，但不导出其逐节点明细。'}};
}
export function beginSolve(root,state,onProgress){
  const id=crypto.randomUUID(),dir=path.join(root,'data','solves',id);fs.mkdirSync(dir,{recursive:true});const resultFile=path.join(dir,'result.json'),input=solverInput(state,resultFile);fs.writeFileSync(path.join(dir,'input.txt'),input.text);fs.writeFileSync(path.join(dir,'scenario.json'),JSON.stringify(state,null,2));
  const engineDir=path.join(root,'engines','TexasSolverCPU'),job={id,engineVersion:'1.1.0-joint-chance',status:'running',startedAt:Date.now(),settings:input.settings,state,log:'',iteration:0,exploitability:null};
  const child=spawn(path.join(engineDir,'console_solver.exe'),['-i',path.join(dir,'input.txt')],{cwd:engineDir,windowsHide:true});
  let raw='',logStream=fs.createWriteStream(path.join(dir,'solver.log')),finished=false;
  const read=data=>{logStream.write(data);raw=(raw+data.toString()).slice(-120000);const start=raw.indexOf('<<<START SOLVING>>>');if(start>=0){job.log=raw.slice(start).replace(/[\x00-\x08]/g,'').slice(-6000);const it=[...job.log.matchAll(/Iter:\s*(\d+)/g)].at(-1),ex=[...job.log.matchAll(/Total exploitability\s+([-\d.eE+]+)\s+precent/g)].at(-1);if(it)job.iteration=Number(it[1]);if(ex)job.exploitability=Number(ex[1]);}onProgress(job);};
  child.stdout.on('data',read);child.stderr.on('data',read);
  const stop=()=>{if(!finished){job.status='cancelled';child.kill();}};
  const timer=setTimeout(()=>{if(!finished){job.status='timeout';child.kill();}},30*60*1000);
  const done=code=>{if(finished)return;finished=true;clearTimeout(timer);logStream.end();job.seconds=(Date.now()-job.startedAt)/1000;if(job.status==='running'){if(code===0&&fs.existsSync(resultFile)){try{JSON.parse(fs.readFileSync(resultFile));job.status='complete';job.converged=job.exploitability!==null&&job.exploitability<=job.settings.accuracy;}catch{job.status='failed';job.error='结果文件无效。';}}else{job.status='failed';job.error='求解器没有生成结果，请检查日志或缩小树。';}}fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify(job,null,2));onProgress(job);};
  child.on('error',e=>{job.error=e.message;done(-1);});child.on('close',done);return {job,stop};
}
export function getNode(tree,state,nodePath=[]){
  const v=validState(state);let node=tree,weights={oop:new Map(v.oop.live.map(c=>[c.label,c.weight])),ip:new Map(v.ip.live.map(c=>[c.label,c.weight]))};
  const canon=x=>cards(x,[2]).sort((a,b)=>a-b).map(cardText).join('');
  for(const step of nodePath){const seat=node.player===1?'oop':'ip',strategy=node.strategy?.strategy,index=node.actions?.indexOf(step);if(index===undefined||index<0||!node.childrens?.[step])throw Error('结果中没有此分支。');if(strategy){for(const [h,probs] of Object.entries(strategy)){const k=canon(h);weights[seat].set(k,(weights[seat].get(k)||0)*probs[index]);}}node=node.childrens[step];}
  const seat=node.player===1?'oop':'ip',op=seat==='oop'?'ip':'oop',actions=node.actions??node.strategy?.actions??[],entries=Object.entries(node.strategy?.strategy??{});let total=0,averages=actions.map(()=>0);
  const opponent=[...weights[op]].map(([h,w])=>({cards:cards(h,[2]),w}));
  const rows=entries.map(([h,p])=>{const key=canon(h),cs=cards(h,[2]),own=weights[seat].get(key)||0,compatible=opponent.reduce((s,c)=>s+(cs.some(x=>c.cards.includes(x))?0:c.w),0),reach=own*compatible;total+=reach;p.forEach((x,i)=>averages[i]+=x*reach);return {hand:key,probabilities:p,weight:own,reach};});
  averages=averages.map(x=>total?x/total:0);return {seat,actions,averages,rows,branches:Object.keys(node.childrens??{}),nodePath,hasStrategy:rows.length>0,reachable:total>0};
}
