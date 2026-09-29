import test from 'node:test';
import assert from 'node:assert/strict';
import {solveRiverGame,prepareRiverGame} from '../lib/river-engine.mjs';
import {explainDecision} from '../lib/decision-explanation.mjs';
import {buildVerifiedCoachLessons,composeVerifiedCoachLesson} from '../lib/coach-lessons.mjs';

test('published lessons bind actual three-way EV, terminal identities and remaining actors; the language model can only select',async()=>{
 const scenario={board:'2c4d6h8sTc',pot:10,hero:'AcAd',heroSeat:0,toAct:0,players:[{id:'a',name:'SB',range:'AcAd,JhJs',stack:20},{id:'b',name:'BB',range:'KcKd,7c7h',stack:20},{id:'c',name:'BTN',range:'QhQs,5c5d',stack:20}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:true,iterations:20};
 const game=prepareRiverGame(scenario),checked=game.nodes.find(n=>n.id===game.nodes[0].actions.find(a=>a.id==='check').childId);
 const result=await solveRiverGame({...scenario,locks:[{nodeId:checked.id,actions:{check:1}}]}),decision=explainDecision(scenario,result,{combo:scenario.hero}),best=Math.max(...decision.actions.map(a=>a.ev));
 const report={context:{root:{players:scenario.players}},decision,evidence:[],verifiedActionFacts:{combo:decision.combo,actor:decision.actorName,actions:decision.actions.map((a,i)=>({id:a.id,label:a.label,netEV:a.ev,lossRelativeToBest:Math.max(0,best-a.ev),netEVID:'E'+(901+i*2),lossEVID:'E'+(902+i*2)}))}};
 const before=structuredClone(report),library=buildVerifiedCoachLessons(report),composed=composeVerifiedCoachLesson(library,['responses:check','balance','experiment']);
 assert.deepEqual(report,before);assert.match(composed.reasoning[1].claim,/BB 过牌.*之后仍轮到 BTN 决策/);assert.match(composed.reasoning[2].claim,/整段范围|整套新策略/);assert.equal(composed.reasoning.length,4);
 assert.match(composed.summary,/沿 过牌 后的真实响应/);assert.match(composed.exercise,/沿 过牌 后的真实路径/);assert.doesNotMatch(composed.exercise,/全下/);
 const comparison=library.blocks.find(b=>b.id.startsWith('difference:'));const compared=composeVerifiedCoachLesson(library,[comparison.id]);assert.match(compared.summary,/净收益差/);assert.equal(compared.exercise,comparison.exercise);
 assert.ok(library.blocks.some(b=>b.id.startsWith('difference:')&&b.body.includes('正向贡献差合计')));
 assert.throws(()=>composeVerifiedCoachLesson(library,['新编一个原因']),/不存在/);assert.throws(()=>composeVerifiedCoachLesson(library,['decision','decision']),/格式/);assert.throws(()=>composeVerifiedCoachLesson(library,[]),/格式/);
 const badEV=structuredClone(report);badEV.verifiedActionFacts.actions[0].netEV+=1;assert.throws(()=>buildVerifiedCoachLessons(badEV),/一致/);
 const badTerm=structuredClone(report);badTerm.decision.actions[0].outcomes[0].evContribution+=1;assert.throws(()=>buildVerifiedCoachLessons(badTerm),/加总/);
 const badComparison=structuredClone(report);badComparison.decision.comparisons[0].alternative.ev+=1;assert.throws(()=>buildVerifiedCoachLessons(badComparison),/总收益差/);
 const badLoss=structuredClone(report);badLoss.verifiedActionFacts.actions[0].lossRelativeToBest+=1;assert.throws(()=>buildVerifiedCoachLessons(badLoss),/相对损失/);
 assert.equal(buildVerifiedCoachLessons({...report,decision:{...decision,exact:false}}),null);
});
