import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStudyReview,DEFAULT_STUDY_REVIEW_POLICY} from '../lib/study-review.mjs';
const start=Date.parse('2026-01-01T00:00:00Z'),H=3600000,D=24*H;
const quality={mode:'exact',targetReached:true,provisional:false,residual:.02,target:.1,countsTowardMastery:false};
const card=(id,q=quality)=>({id,createdAt:new Date(start-D).toISOString(),full:{kind:'study-action',title:id,quality:q,choices:[{id:'check'},{id:'bet'}],referenceEV:1,actionEV:{check:0,bet:1},evTolerance:.01}});
const attempt=(cardId,hours,correct=true,extra={})=>({id:`${cardId}-${hours}-${correct}`,cardId,createdAt:new Date(start+hours*H).toISOString(),answer:correct?'bet':'check',correct,confidence:60,...extra});
const build=(cs,as,hours=240,options={})=>buildStudyReview(cs,as,{now:start+hours*H,...options});

test('new cards do not pollute learned scores, due counts, or delayed retrieval',()=>{
 const r=build([card('a'),card('b')],[]);assert.equal(r.newCards.length,2);assert.equal(r.due.length,0);assert.equal(r.summary.seenCards,0);assert.equal(r.summary.firstExposure.accuracy,null);assert.equal(r.summary.delayedRetrieval.accuracy,null);assert.ok(r.byCard.every(x=>x.firstAttemptCorrect===null&&x.nextDueAt===null&&x.stage==='new'));
});

test('chronological order, not UUID or filesystem ordering, determines first exposure',()=>{
 const cs=[card('a')],as=[attempt('a',24,true,{id:'a'}),attempt('a',0,false,{id:'z'})],copy=structuredClone({cs,as});const r=build(cs,as);assert.equal(r.byCard[0].firstAttemptCorrect,false);assert.equal(r.byCard[0].delayedRetests,1);assert.equal(r.summary.firstExposure.correct,0);assert.equal(r.summary.delayedRetrieval.correct,1);assert.deepEqual(build(cs,as.toReversed()),r);assert.deepEqual({cs,as},copy);
});

test('immediate correct retries cannot erase a high-confidence error or extend its short review',()=>{
 const first=attempt('a',0,false,{confidence:95}),fast=attempt('a',.01,true),r=build([card('a')],[first,fast],2),row=r.byCard[0];assert.equal(row.stage,'relearning');assert.equal(row.priority,'high');assert.equal(row.intervalDays,.25);assert.equal(row.nextDueAt,new Date(start+6*H).toISOString());assert.equal(row.delayedRetests,0);assert.equal(row.highConfidenceErrors,1);assert.equal(row.due,false);
 const after=build([card('a')],[first,fast,attempt('a',6,true)],6).byCard[0];assert.equal(after.stage,'learning');assert.equal(after.intervalDays,1);assert.equal(after.nextDueAt,new Date(start+30*H).toISOString());assert.equal(after.delayedRetests,0);assert.equal(after.priority,'normal');
});

test('same-day repeated success never raises the interval ladder or manufactures independent first attempts',()=>{
 const as=Array.from({length:100},(_,i)=>attempt('a',i/100,true));const r=build([card('a')],as,2),row=r.byCard[0];assert.equal(row.intervalDays,1);assert.equal(row.delayedCorrectStreak,0);assert.equal(row.delayedRetests,0);assert.equal(row.shortGapAttempts,99);assert.equal(r.summary.firstExposure.count,1);assert.equal(r.summary.totalAttempts,100);
});

test('delayed retrieval requires a full 24 hours since the previous valid exposure',()=>{
 const r=build([card('exact'),card('early'),card('refreshed')],[attempt('exact',0),attempt('exact',24),attempt('early',0),attempt('early',24-1/H),attempt('refreshed',0),attempt('refreshed',12),attempt('refreshed',24)],25);assert.equal(r.byCard.find(x=>x.id==='exact').delayedRetests,1);assert.equal(r.byCard.find(x=>x.id==='early').delayedRetests,0);assert.equal(r.byCard.find(x=>x.id==='refreshed').delayedRetests,0);assert.equal(r.summary.delayedRetrieval.count,1);
});

test('successful due reviews follow the visible capped ladder but never claim mastery',()=>{
 const r=build([card('a')],[0,24,96,264,600,1320].map(h=>attempt('a',h)),1320),row=r.byCard[0];assert.equal(row.intervalDays,30);assert.equal(row.delayedCorrectStreak,5);assert.equal(row.stage,'delayed-review');assert.equal(row.delayedCorrect,5);assert.equal(row.eligibleDelayedCorrect,5);assert.equal(row.countsTowardMastery,false);assert.equal(r.summary.countsTowardMastery,false);assert.deepEqual(r.policy.intervalDays,[...DEFAULT_STUDY_REVIEW_POLICY.intervalDays]);
});

test('an early extra delayed test is recorded but does not prematurely grow a longer planned interval',()=>{
 const r=build([card('a')],[attempt('a',0),attempt('a',24),attempt('a',48)],49),row=r.byCard[0];assert.equal(row.delayedRetests,2);assert.equal(row.intervalDays,3);assert.equal(row.delayedCorrectStreak,1);assert.equal(row.nextDueAt,new Date(start+96*H).toISOString());
});

test('sampled, unmet-target, inconsistent-target and unknown references never enter trustworthy-reference metrics',()=>{
 const cs=[card('good'),card('sample',{...quality,mode:'sampled'}),card('unmet',{...quality,targetReached:false}),card('contradiction',{...quality,residual:2}),card('unknown',{})],as=cs.flatMap(c=>[attempt(c.id,0),attempt(c.id,24)]),r=build(cs,as,25);assert.equal(r.summary.firstExposure.count,5);assert.equal(r.summary.firstExposure.eligibleCount,1);assert.equal(r.summary.delayedRetrieval.count,5);assert.equal(r.summary.delayedRetrieval.eligibleCount,1);assert.ok(r.byCard.filter(c=>c.id!=='good').every(c=>c.quality.provisional&&c.eligibleDelayedCorrect===0&&c.intervalDays===1&&c.stage==='provisional-review'));
});

test('an attempt graded under a provisional reference cannot gain credit from a later better card reference',()=>{
 const r=build([card('a')],[attempt('a',0,true,{quality:{...quality,mode:'sampled'}}),attempt('a',24,true,{quality:{...quality,targetReached:false}})],25);assert.equal(r.summary.firstExposure.eligibleCount,0);assert.equal(r.summary.delayedRetrieval.eligibleCount,0);assert.equal(r.byCard[0].intervalDays,1);
});

test('an asserted target flag without measured residual and target is not trustworthy evidence',()=>{
 const r=build([card('legacy',{mode:'exact',targetReached:true,provisional:false})],[attempt('legacy',0),attempt('legacy',24)],25);assert.equal(r.byCard[0].quality.targetReached,false);assert.equal(r.byCard[0].quality.eligibleForRetentionEvidence,false);assert.equal(r.summary.delayedRetrieval.eligibleCount,0);
});

test('orphan, malformed, future, duplicate and inconsistent graded attempts are excluded',()=>{
 const good=attempt('a',0),r=build([card('a'),{id:'bad'},card('a')],[good,{...good},attempt('missing',1),attempt('bad',2),{...attempt('a',3),createdAt:'broken'},attempt('a',300),attempt('a',4,true,{confidence:101}),attempt('a',5,true,{answer:'check'})],24);assert.equal(r.summary.totalAttempts,1);assert.equal(r.ignored.invalidCards.length,1);assert.equal(r.ignored.duplicateCards.length,1);assert.equal(r.ignored.orphanAttempts.length,2);assert.equal(r.ignored.invalidAttempts.length,3);assert.equal(r.ignored.futureAttempts.length,1);assert.equal(r.ignored.duplicateAttempts.length,1);
});

test('due order gives high-confidence errors priority and ordinary errors get a short check',()=>{
 const r=build([card('normal'),card('high'),card('new')],[attempt('normal',0,false),attempt('high',10,false,{confidence:90})],24);assert.deepEqual(r.due.map(x=>x.id),['high','normal']);assert.equal(r.byCard.find(x=>x.id==='normal').intervalDays,.5);assert.equal(r.newCards.length,1);
});

test('policy changes are explicit bounded heuristics and invalid time never generates a fake schedule',()=>{
 const r=build([card('a')],[attempt('a',0),attempt('a',48)],49,{policy:{minDelayedHours:48,intervalDays:[2,5,10]}});assert.equal(r.byCard[0].intervalDays,5);assert.equal(r.policy.minDelayedHours,48);assert.throws(()=>buildStudyReview([],[],{now:'bad'}),/时间/);assert.throws(()=>build([],[],1,{policy:{minDelayedHours:12}}),/24/);assert.throws(()=>build([],[],1,{policy:{intervalDays:[1,.5]}}),/间隔/);
});
