import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCoachActionReferences} from '../lib/local-coach.mjs';
const report={verifiedActionFacts:{actions:[{id:'check',label:'过牌'},{id:'bet_20',label:'下注 20 BB'},{id:'bet_80',label:'全下 80 BB'}]},evidence:[{id:'E001',metric:'net-ev',actionId:'check',value:5},{id:'E002',metric:'net-ev',actionId:'bet_20',value:6},{id:'E003',metric:'net-ev',actionId:'bet_80',value:4},{id:'E004',metric:'relative-best-loss',actionId:'bet_80',value:2},{id:'E005',metric:'response-probability',actionId:'bet_80',value:.3}]};
test('same-unit same-metric references cannot be explicitly attributed to the wrong action',()=>{
 for(const text of ['全下的净 EV 为 {{E001}}。','过牌的净收益为 {{E003}}。','下注20BB的净EV为{{E003}}。','过牌相对最佳动作的损失为{{E004}}。'])assert.throws(()=>validateCoachActionReferences(text,report),/另一个动作/);
});
test('correct explicit action binding and response-branch language remain legal',()=>{
 for(const text of ['全下的净 EV 为 {{E003}}，相对最佳动作的损失为 {{E004}}。','过牌净收益为 {{E001}}。下注 20 BB 的净收益为 {{E002}}。','全下后对手弃牌概率为 {{E005}}。','比较过牌与全下，前者的净EV为{{E001}}。'])assert.equal(validateCoachActionReferences(text,report),true);
});
test('a generic label spanning multiple bet sizes is not guessed as a unique action',()=>{
 assert.equal(validateCoachActionReferences('下注的净EV为{{E002}}。',report),true);
 assert.equal(validateCoachActionReferences('{{E001}}',{evidence:report.evidence}),true);
 assert.equal(validateCoachActionReferences('全下净 EV {{E003}}',{...report,verifiedActionFacts:{actions:[{label:'全下 80 BB'}]}}),true);
});
