import test from 'node:test';
import assert from 'node:assert/strict';
import {cards,range} from '../lib/poker.mjs';
import {prepareEquity,exactMultiRiver,sampleMultiCPU} from '../lib/multi-equity.mjs';
const near=(a,b,t=1e-10)=>assert(Math.abs(a-b)<t,`${a} != ${b}`);
test('three-player exact equity, weighted ranges and card compatibility',()=>{
 const b=cards('2c 3d 7h 9s Jc'),rs=['AA','KK','QQ'].map(s=>range(s,b).live),x=exactMultiRiver(rs,b);
 near(x.players[0].equity,1);near(x.players[1].equity,0);near(x.players[2].equity,0);
 const r=['AsAd','KsKd','AhAc:0.5,QhQc'].map(s=>range(s,b).live),y=exactMultiRiver(r,b);near(y.players[0].equity,5/6);near(y.players[2].equity,1/6);
 for(const p of y.players){near(p.combos.reduce((s,c)=>s+c.reach,0),1);near(p.combos.reduce((s,c)=>s+c.reach*(c.equity??0),0),p.equity);}
});
test('nine-way board tie divides exactly and retains every player',()=>{
 const b=cards('As Ks Qs Js Ts'),rs=['2c2d','3c3d','4c4d','5c5d','6c6d','7c7d','8c8d','9c9d','TcTd'].map(s=>range(s,b).live),x=exactMultiRiver(rs,b);
 assert.equal(x.players.length,9);for(const p of x.players){near(p.equity,1/9);near(p.tieProbability,1);}
 near(x.players.reduce((s,p)=>s+p.equity,0),1);
});
test('empty joint assignments and hero collisions are rejected',()=>{
 assert.throws(()=>prepareEquity({board:'2c3d7h',players:[{range:'AsAd'},{range:'AsAc'}]}));
 assert.throws(()=>prepareEquity({board:'2c3d7h',hero:'2c4d',players:[{range:'AA'},{range:'KK'}]}));
});
test('rejection sampler preserves compatibility-conditioned probabilities',()=>{
 const b=cards('2c3d7h9sJc'),rs=['AA,KK','AA,QQ:0.5','KK,JJ'].map(s=>range(s,b).live),ex=exactMultiRiver(rs,b),mc=sampleMultiCPU(rs,b,60000,789);
 for(let p=0;p<3;p++)near(mc.players[p].equity,ex.players[p].equity,Math.max(.002,mc.players[p].ci*3));
 near(mc.players.reduce((s,p)=>s+p.equity,0),1);
});
