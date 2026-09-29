import test from 'node:test';
import assert from 'node:assert/strict';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {createRangeConstruction,gradeRangeConstruction,evaluateRangeConstruction} from '../lib/strategy-construction.mjs';
import {buildRangeDebrief} from '../lib/range-debrief.mjs';
const input={title:'教学证据',board:'Ks7h2d9c3s',pot:10,players:[{id:'a',name:'A',range:'AcKd,AhQh',stack:20},{id:'b',name:'B',range:'KcQd,QhJh',stack:20}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false,iterations:40,accuracy:.1};
const result=await solveRiverGame(input);
const submission=(weighting='observed')=>{const q=createRangeConstruction(input,result,{weighting}).publicQuestion;return {weighting,sourceFingerprint:q.sourceFingerprint,assignments:q.combos.filter(c=>c.editable).map(c=>({combo:c.combo,probabilities:Object.fromEntries(q.actions.map((a,i)=>[a.id,i===0?1:0]))}))};};
test('teaching scaffold quotes actual weighted regret and marks missing adaptation evidence',()=>{
 const grade=gradeRangeConstruction(input,result,submission()),debrief=buildRangeDebrief(grade,{jobId:'example',nodePath:[]});assert.equal(debrief.balance.status,'not-run');assert.equal(debrief.basis.localRegretBB,grade.metrics.localRegretBB);
 for(const item of debrief.focus){const row=grade.combos.find(c=>c.combo===item.combo);assert.equal(item.rangeRegretContributionBB,row.weightedRegretBB);assert.equal(item.userEV,row.userEV);assert.equal(item.target.combo,row.combo);assert.ok(item.question.includes('预测')||item.question.includes('解释'));}
 assert.ok(debrief.distribution.every(x=>x.description.includes('不直接构成错误')));assert.ok(debrief.limitations.some(x=>x.includes('不自动判断')));
});
test('counterfactual teaching never describes its weights as observed posterior reach',()=>{
 const debrief=buildRangeDebrief(gradeRangeConstruction(input,result,submission('counterfactual')),{jobId:'example'});assert.ok(debrief.focus.every(x=>x.summary.includes('反事实范围权重')));assert.ok(debrief.distribution.every(x=>x.description.includes('反事实研究范围')));assert.ok(debrief.focus.every(x=>!x.summary.includes('当前到达权重')));
});
test('full HU and multiway debriefs keep fixed-response, security, and unilateral gains distinct',async()=>{
 const evaluated=await evaluateRangeConstruction(input,result,submission()),debrief=buildRangeDebrief(evaluated);assert.equal(debrief.balance.kind,'heads-up-security');assert.equal(debrief.balance.securityEVChangeBB,evaluated.independentEvaluation.responseExposure.securityEVChangeBB);assert.ok(debrief.balance.limits.some(x=>x.includes('没有证明具体')));
 const multi={...evaluated,independentEvaluation:{...evaluated.independentEvaluation,responseExposure:{kind:'multiplayer-unilateral-gains',players:[{name:'B',baselineGainBB:0,submittedGainBB:5},{name:'C',baselineGainBB:.1,submittedGainBB:4}]}}},m=buildRangeDebrief(multi);assert.equal(m.balance.kind,'multiplayer-unilateral-gains');assert.ok(m.balance.limits.some(x=>x.includes('不能相加成你的损失')));assert.equal(m.balance.securityEVChangeBB,undefined);
});
