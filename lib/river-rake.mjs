/** A deliberately narrow cash-game fee model: the initial gross pot has already
 * reached the supplied cap, but the fee has NOT yet been removed from that pot.
 * The same fixed fee is therefore due at every terminal. Betting sizes continue
 * to use the table's gross pot, and all later uncalled chips are refunded intact.
 * Variable, uncapped, promotional, jackpot and per-player fees are not modeled. */
export function fixedCappedRake(raw,pot){
  const ratePct=Number(raw.rake??0),cap=Number(raw.rakeCap??raw.cap??0);
  if(!Number.isFinite(ratePct)||ratePct<0||ratePct>20)throw Error('抽水百分比必须在 0–20 之间。');
  if(!Number.isFinite(cap)||cap<0||cap>10000000)throw Error('抽水封顶必须为非负 BB 金额。');
  if(ratePct===0)return {type:'none',ratePct:0,cap,fixedRake:0,grossStartingPot:pot,netStartingPot:pot,capReachedAtRoot:false};
  if(cap<=0)throw Error('非零抽水必须设置 rakeCap（BB）；目前只支持起始底池已经达到封顶的固定抽水。');
  if(pot*ratePct/100+1e-10<cap)throw Error('起始底池尚未达到抽水封顶；当前精确引擎不支持随终局底池变化的未封顶抽水，请调整场景或设为无抽水。');
  return {type:'fixed-cap-reached-at-root',ratePct,cap,fixedRake:cap,grossStartingPot:pot,netStartingPot:pot-cap,capReachedAtRoot:true,meaning:'Starting pot is gross, before this fee is removed. The fixed cap is deducted once from the common starting pot at every terminal. Later contributions and uncalled refunds are not raked again.'};
}
