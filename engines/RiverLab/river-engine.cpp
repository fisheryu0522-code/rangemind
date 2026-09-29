// PokerLab RiverLab — exact chance / finite no-limit river tree solver.
// Original implementation, 2026. JSON parser: nlohmann/json (MIT), see json.hpp.
#include "json.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <numeric>
#include <string>
#include <vector>
#include <omp.h>
using json=nlohmann::json;
using Values=std::array<double,6>;
struct Deal { std::array<int,6> hands{},ranks{}; double weight=0; };
struct Node { int actor=-1,parent=-1,parentAction=-1,leaf=-1; std::vector<int> children; std::vector<double> contrib; std::vector<bool> folded; size_t offset=0; int combos=0; };

class Engine {
public:
  json in; int N=0,D=0,iteration=0,threads=1; double pot=0,fixedRake=0; size_t cells=0; std::vector<Deal> deals; std::vector<Node> nodes;
  bool zeroReachPruning=true,dcfr=false,alternating=false,evaluationOnly=false;
  std::vector<double> terminal; std::vector<double> regrets,average,strategy; std::vector<bool> fixed;
  std::chrono::steady_clock::time_point started=std::chrono::steady_clock::now();
  explicit Engine(json input):in(std::move(input)) {
    N=in["players"].size(); pot=in["pot"].get<double>();fixedRake=in.value("fixedRake",0.0);if(!std::isfinite(fixedRake)||fixedRake<0||fixedRake>pot)throw std::runtime_error("Invalid fixed rake.");evaluationOnly=in.value("evaluationOnly",false);zeroReachPruning=in.value("zeroReachPruning",true);dcfr=in.value("algorithm",std::string("cfr-plus"))=="dcfr";alternating=in.value("algorithm",std::string("cfr-plus"))=="alternating-cfr-plus";
    for(auto &d:in["deals"]){Deal v;for(int p=0;p<N;p++){v.hands[p]=d["hands"][p];v.ranks[p]=d["ranks"][p];}v.weight=d["weight"];deals.push_back(v);}D=deals.size();in["deals"]=nullptr;
    int leaf=0;
    for(auto &j:in["nodes"]){Node n;n.actor=j["actor"];n.contrib=j["contributions"].get<std::vector<double>>();n.folded=j["folded"].get<std::vector<bool>>();if(n.actor<0)n.leaf=leaf++;else {n.combos=in["combinations"][n.actor].size();n.offset=cells;for(auto &a:j["actions"])n.children.push_back(a["child"]);cells+=n.combos*n.children.size();}nodes.push_back(n);}
    if(size_t(leaf)*D*N>450000000||cells>20000000)throw std::runtime_error("Exact engine memory budget exceeded. Reduce ranges or action sizes.");
    for(size_t i=0;i<nodes.size();i++)for(size_t a=0;a<nodes[i].children.size();a++){auto &c=nodes[nodes[i].children[a]];c.parent=i;c.parentAction=a;}
    threads=std::min(in.value("threads",1),std::max(1,int(128000000/std::max(size_t(1),cells))));if(size_t(D)*nodes.size()<100000)threads=1;omp_set_num_threads(threads);
    terminal.resize(size_t(leaf)*D*N);regrets.assign(cells,0);average.assign(cells,0);strategy.assign(cells,0);fixed.assign(cells,false);
    #pragma omp parallel for schedule(dynamic,1)
    for(int i=0;i<int(nodes.size());i++){const Node &n=nodes[i];if(n.actor<0)for(int d=0;d<D;d++)storeTerminal(n,d);}
    policies(false);
    if(evaluationOnly)for(const auto &n:nodes)if(n.actor>=0)for(int c=0;c<n.combos;c++)if(!fixed[n.offset+c*n.children.size()])throw std::runtime_error("Policy evaluation requires a complete locked policy at every information set.");
  }
  double seconds() const {return std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count();}
  Values payoff(const Node &node,const Deal &deal) const {
    Values result{};for(int p=0;p<N;p++)result[p]=-node.contrib[p];
    auto award=[&](double amount,const std::vector<int>& eligible){if(amount<=0)return;if(eligible.empty())throw std::runtime_error("Side pot without eligible player.");int best=-1,count=0;for(int p:eligible)best=std::max(best,deal.ranks[p]);for(int p:eligible)if(deal.ranks[p]==best)count++;for(int p:eligible)if(deal.ranks[p]==best)result[p]+=amount/count;};
    std::vector<int> alive;for(int p=0;p<N;p++)if(!node.folded[p])alive.push_back(p);award(pot-fixedRake,alive);
    std::vector<double> levels=node.contrib;std::sort(levels.begin(),levels.end());levels.erase(std::unique(levels.begin(),levels.end()),levels.end());double last=0;
    for(double level:levels){if(level<=last+1e-9)continue;std::vector<int> contributors,eligible;for(int p=0;p<N;p++)if(node.contrib[p]>=level-1e-9){contributors.push_back(p);if(!node.folded[p])eligible.push_back(p);}const double amount=(level-last)*contributors.size();if(contributors.size()==1)result[contributors[0]]+=amount;else award(amount,eligible);last=level;}
    return result;
  }
  Values terminalValue(const Node &n,int d) const {Values v{};const size_t offset=(size_t(n.leaf)*D+d)*N;for(int p=0;p<N;p++)v[p]=terminal[offset+p];return v;}
  void storeTerminal(const Node &n,int d){const auto v=payoff(n,deals[d]);const size_t offset=(size_t(n.leaf)*D+d)*N;for(int p=0;p<N;p++)terminal[offset+p]=v[p];}
  void applyLocks(){for(auto &l:in["locks"]){const int id=l["node"],combo=l["combo"];const Node &n=nodes[id];int A=n.children.size();for(int c=0;c<n.combos;c++)if(combo<0||combo==c){fixed[n.offset+c*A]=true;for(int a=0;a<A;a++)strategy[n.offset+c*A+a]=l["probabilities"][a];}}}
  void policies(bool useAverage){
    const auto &v=useAverage?average:regrets;
    for(const Node &n:nodes)if(n.actor>=0){int A=n.children.size();for(int c=0;c<n.combos;c++){double sum=0;for(int a=0;a<A;a++)sum+=std::max(0.0,v[n.offset+c*A+a]);for(int a=0;a<A;a++)strategy[n.offset+c*A+a]=sum>1e-100?std::max(0.0,v[n.offset+c*A+a])/sum:1.0/A;}}
    applyLocks();
  }
  void accumulateAverage(double weight){
    if(weight<=0)return;
    for(size_t id=0;id<nodes.size();id++){const Node &n=nodes[id];if(n.actor<0)continue;const int A=n.children.size();for(int c=0;c<n.combos;c++){
      double ownReach=1;int child=id;while(nodes[child].parent>=0){int parent=nodes[child].parent;const Node &pn=nodes[parent];if(pn.actor==n.actor)ownReach*=strategy[pn.offset+c*pn.children.size()+nodes[child].parentAction];child=parent;}
      for(int a=0;a<A;a++)average[n.offset+c*A+a]+=weight*ownReach*strategy[n.offset+c*A+a];
    }}
  }
  Values cfr(int id,int d,Values reach,double *regretDelta){
    if(zeroReachPruning){int zeros=0;for(int p=0;p<N;p++)zeros+=reach[p]==0;if(zeros>=2)return Values{};}
    const Node &n=nodes[id];if(n.actor<0)return terminalValue(n,d);
    const int p=n.actor,A=n.children.size(),combo=deals[d].hands[p];const size_t off=n.offset+combo*A;
    std::array<Values,8> child{};Values value{};
    for(int a=0;a<A;a++){auto r=reach;r[p]*=strategy[off+a];child[a]=cfr(n.children[a],d,r,regretDelta);for(int k=0;k<N;k++)value[k]+=strategy[off+a]*child[a][k];}
    double counterfactual=deals[d].weight;for(int k=0;k<N;k++)if(k!=p)counterfactual*=reach[k];
    for(int a=0;a<A;a++)regretDelta[off+a]+=counterfactual*(child[a][p]-value[p]);
    return value;
  }
  double cfrPlayer(int id,int d,int player,double counterfactualReach,double *regretDelta){
    if(zeroReachPruning&&counterfactualReach==0)return 0;
    const Node &n=nodes[id];if(n.actor<0)return terminal[(size_t(n.leaf)*D+d)*N+player];
    const int A=n.children.size();const size_t off=n.offset+deals[d].hands[n.actor]*A;double value=0;
    if(n.actor==player){std::array<double,8> child{};for(int a=0;a<A;a++){child[a]=cfrPlayer(n.children[a],d,player,counterfactualReach,regretDelta);value+=strategy[off+a]*child[a];}for(int a=0;a<A;a++)regretDelta[off+a]+=counterfactualReach*(child[a]-value);}
    else for(int a=0;a<A;a++){const double probability=strategy[off+a];if(probability>0||!zeroReachPruning)value+=probability*cfrPlayer(n.children[a],d,player,counterfactualReach*probability,regretDelta);}
    return value;
  }
  // A single action is selected for every hidden deal sharing the acting
  // player's hand and public history. Opponent private cards never enter the
  // maximization key. This is the essential information-set BR constraint.
  std::vector<double> bestResponse(int id,int player,const std::vector<double> &counterfactualReach,bool respectLocks=false) const {
    const Node &n=nodes[id];std::vector<double> value(D,0);
    if(n.actor<0){for(int d=0;d<D;d++)value[d]=terminal[(size_t(n.leaf)*D+d)*N+player];return value;}
    const int A=n.children.size();std::vector<std::vector<double>> child;child.reserve(A);
    for(int a=0;a<A;a++){auto reach=counterfactualReach;if(n.actor!=player)for(int d=0;d<D;d++)reach[d]*=strategy[n.offset+deals[d].hands[n.actor]*A+a];child.push_back(bestResponse(n.children[a],player,reach,respectLocks));}
    if(n.actor==player){
      std::vector<double> totals(size_t(n.combos)*A,0);for(int d=0;d<D;d++)for(int a=0;a<A;a++)totals[deals[d].hands[player]*A+a]+=counterfactualReach[d]*child[a][d];
      std::vector<int> best(n.combos,0);for(int c=0;c<n.combos;c++)for(int a=1;a<A;a++)if(totals[c*A+a]>totals[c*A+best[c]])best[c]=a;
      for(int d=0;d<D;d++){const int c=deals[d].hands[player];if(respectLocks&&fixed[n.offset+c*A])for(int a=0;a<A;a++)value[d]+=strategy[n.offset+c*A+a]*child[a][d];else value[d]=child[best[c]][d];}
    }else for(int d=0;d<D;d++)for(int a=0;a<A;a++)value[d]+=strategy[n.offset+deals[d].hands[n.actor]*A+a]*child[a][d];
    return value;
  }
  Values profile(int id,int d) const {const Node &n=nodes[id];if(n.actor<0)return terminalValue(n,d);Values v{};int A=n.children.size();for(int a=0;a<A;a++){const auto child=profile(n.children[a],d);const double probability=strategy[n.offset+deals[d].hands[n.actor]*A+a];for(int p=0;p<N;p++)v[p]+=probability*child[p];}return v;}
  json diagnostics() const {
    Values values{},br{},gains{};for(int d=0;d<D;d++){const auto v=profile(0,d);for(int p=0;p<N;p++)values[p]+=deals[d].weight*v[p];}
    std::vector<double> reach;for(const auto &d:deals)reach.push_back(d.weight);
    double nash=0;for(int p=0;p<N;p++){auto v=bestResponse(0,p,reach);for(int d=0;d<D;d++)br[p]+=deals[d].weight*v[d];if(br[p]<values[p]-1e-7*(pot+in["players"][p]["stack"].get<double>()))throw std::runtime_error("Best-response verification failed: response value below profile value.");gains[p]=std::max(0.0,br[p]-values[p]);nash+=gains[p];}
    auto array=[&](Values v){return std::vector<double>(v.begin(),v.begin()+N);};
    json result={{"profileEV",array(values)},{"bestResponseEV",array(br)},{"gain",array(gains)},{"nashConv",nash},{"nashConvPctPot",100*nash/pot},{"verifiedBy","information-set-consistent exact best response"},{"definition","Sum over players of unilateral best-response improvement against the reported average strategy, within this finite action tree."},{"interpretation",N==2?"Two-player constant-sum game; conventional exploitability equals NashConv / 2.":"Multiplayer residual, not a convergence guarantee. Each player deviates alone; no coalition model."},{"locksPresent",!in["locks"].empty()},{"bestResponseIgnoresLocks",true},{"optimizationResidualPctPot",100*nash/pot},{"residualForStopping","nashConvPctPot"}};
    if(!in["locks"].empty()&&!evaluationOnly){
      Values cb{},cg{};double cn=0;for(int p=0;p<N;p++){auto v=bestResponse(0,p,reach,true);for(int d=0;d<D;d++)cb[p]+=deals[d].weight*v[d];cg[p]=std::max(0.0,cb[p]-values[p]);cn+=cg[p];}
      result["constrainedBestResponseEV"]=array(cb);result["constrainedGain"]=array(cg);result["constrainedNashConv"]=cn;result["constrainedNashConvPctPot"]=100*cn/pot;result["optimizationResidualPctPot"]=100*cn/pot;result["residualForStopping"]="constrainedNashConvPctPot";
      result["lockInterpretation"]="Unrestricted NashConv permits deviating from locked strategies and may be irreducible. Constrained NashConv preserves every locked information-set distribution, measures optimization only over remaining free decisions, and is the stopping criterion.";
    }
    return result;
  }
  json holdout(){
    if(!in.contains("evaluationDeals")||in["evaluationDeals"].empty())return nullptr;
    deals.clear();for(auto &d:in["evaluationDeals"]){Deal v;for(int p=0;p<N;p++){v.hands[p]=d["hands"][p];v.ranks[p]=d["ranks"][p];}v.weight=d["weight"];deals.push_back(v);}D=deals.size();in["evaluationDeals"]=nullptr;
    int leaves=0;for(auto &n:nodes)if(n.actor<0)leaves++;
    std::vector<double>().swap(terminal);terminal.resize(size_t(leaves)*D*N);
    #pragma omp parallel for schedule(dynamic,1)
    for(int i=0;i<int(nodes.size());i++){const Node &n=nodes[i];if(n.actor<0)for(int d=0;d<D;d++)storeTerminal(n,d);}
    auto diag=diagnostics();Values square{};for(int d=0;d<D;d++){auto v=profile(0,d);for(int p=0;p<N;p++)square[p]+=deals[d].weight*v[p]*v[p];}
    const int samples=in["chance"]["holdout"]["samples"];json ci=json::array();for(int p=0;p<N;p++){const double mean=diag["profileEV"][p];const double se=std::sqrt(std::max(0.0,square[p]-mean*mean)/(samples-1));ci.push_back({{"player",p},{"standardError",se},{"low95",mean-1.96*se},{"high95",mean+1.96*se}});}
    diag["profileEVSamplingCI"]=ci;diag["uniqueDeals"]=D;diag["sampleCount"]=samples;diag["sameFixedStrategy"]=true;
    diag["verifiedBy"]="Information-set-consistent exact best response within independent empirical validation distribution";
    diag["meaning"]="Independent chance sample evaluating the same fixed training strategy. Empirical best responses are optimized on this holdout sample; this residual is a diagnostic, not a full-game exploitability bound. Profile-EV intervals concern chance sampling only, not model or strategic uncertainty.";
    return diag;
  }
  // Exact counterfactual conditional action values and full-joint node reaches.
  // Descendant EVs always use the reported average strategy, not a BR policy.
  std::vector<Values> reportNode(int id,const std::vector<Values>& reach,json &output) const {
    const Node &n=nodes[id];std::vector<Values> value(D);
    json j=in["nodes"][id];j.erase("lastFullRaise");j.erase("currentBet");j.erase("raises");
    double nodeReach=0;for(int d=0;d<D;d++){double r=deals[d].weight;for(int p=0;p<N;p++)r*=reach[d][p];nodeReach+=r;}j["reach"]=nodeReach;
    if(n.actor<0){Values expected{};for(int d=0;d<D;d++){value[d]=terminalValue(n,d);double r=deals[d].weight;for(int p=0;p<N;p++)r*=reach[d][p];for(int p=0;p<N;p++)expected[p]+=r*(value[d][p]+n.contrib[p]);}j["expectedAward"]=json::array();for(int p=0;p<N;p++)j["expectedAward"].push_back(nodeReach>1e-100?json(expected[p]/nodeReach):json(nullptr));j["combos"]=json::array();output[id]=std::move(j);return value;}
    const int p=n.actor,A=n.children.size();std::vector<std::vector<Values>> child;child.reserve(A);
    for(int a=0;a<A;a++){auto r=reach;for(int d=0;d<D;d++)r[d][p]*=strategy[n.offset+deals[d].hands[p]*A+a];child.push_back(reportNode(n.children[a],r,output));}
    std::vector<double> denom(n.combos,0),joint(n.combos,0),ev(size_t(n.combos)*A,0);std::vector<double> actionMass(A,0),actionValue(A,0),selectedValue(A,0);j["combos"]=json::array();
    for(int d=0;d<D;d++){
      double cf=deals[d].weight,full=deals[d].weight;for(int k=0;k<N;k++){full*=reach[d][k];if(k!=p)cf*=reach[d][k];}int c=deals[d].hands[p];denom[c]+=cf;joint[c]+=full;
      for(int a=0;a<A;a++){const double s=strategy[n.offset+c*A+a];ev[c*A+a]+=cf*(child[a][d][p]+n.contrib[p]);actionMass[a]+=full*s;actionValue[a]+=full*(child[a][d][p]+n.contrib[p]);selectedValue[a]+=full*s*(child[a][d][p]+n.contrib[p]);for(int k=0;k<N;k++)value[d][k]+=s*child[a][d][k];}
    }
    for(int c=0;c<n.combos;c++){
      auto meta=in["combinations"][p][c];json row={{"combo",meta["combo"]},{"weight",meta["weight"]},{"reach",joint[c]},{"counterfactualReach",denom[c]},{"locked",bool(fixed[n.offset+c*A])},{"probabilities",json::array()},{"actionEV",json::array()},{"ev",nullptr}};double total=0;
      for(int a=0;a<A;a++){const double s=strategy[n.offset+c*A+a];row["probabilities"].push_back(s);if(denom[c]>1e-100){double v=ev[c*A+a]/denom[c];row["actionEV"].push_back(v);total+=s*v;}else row["actionEV"].push_back(nullptr);}if(denom[c]>1e-100)row["ev"]=total;j["combos"].push_back(row);
    }
    double nodeEV=0;for(int a=0;a<A;a++){j["actions"][a].erase("child");j["actions"][a]["frequency"]=nodeReach>1e-100?json(actionMass[a]/nodeReach):json(nullptr);j["actions"][a]["ev"]=nodeReach>1e-100?json(actionValue[a]/nodeReach):json(nullptr);j["actions"][a]["selectedEV"]=actionMass[a]>1e-100?json(selectedValue[a]/actionMass[a]):json(nullptr);nodeEV+=selectedValue[a];}j["profileEV"]=nodeReach>1e-100?json(nodeEV/nodeReach):json(nullptr);j["aggregateEVMeaning"]="action.ev forces every currently reached acting hand to that action. action.selectedEV conditions on the hand range actually taking it. Compare actions using a specific combo's actionEV; different selected ranges are not like-for-like.";
    output[id]=std::move(j);return value;
  }
  json run(){
    const int maxIterations=evaluationOnly?0:in["iterations"].get<int>(),delay=in["averagingDelay"],checkEvery=in["checkEvery"];const double maxSeconds=in["maxSeconds"];json diag;std::string reason=evaluationOnly?"policy_evaluated":"iteration_limit";
    std::vector<std::vector<double>> threadDelta(threads,std::vector<double>(cells,0));
    for(iteration=1;iteration<=maxIterations;iteration++){
      const double t=std::max(0,iteration-delay);
      if(alternating){
        for(int player=0;player<N;player++){
          policies(false);for(auto &v:threadDelta)std::fill(v.begin(),v.end(),0);
          if(threads==1){for(int d=0;d<D;d++)cfrPlayer(0,d,player,deals[d].weight,threadDelta[0].data());}
          else{
            #pragma omp parallel for schedule(static)
            for(int d=0;d<D;d++)cfrPlayer(0,d,player,deals[d].weight,threadDelta[omp_get_thread_num()].data());
          }
          for(const auto &n:nodes)if(n.actor==player)for(size_t i=n.offset;i<n.offset+n.combos*n.children.size();i++){double sum=0;for(int t=0;t<threads;t++)sum+=threadDelta[t][i];regrets[i]=std::max(0.0,regrets[i]+sum);}
        }
        policies(false);accumulateAverage(t);
      }else{
        policies(false);for(auto &v:threadDelta)std::fill(v.begin(),v.end(),0);Values reach{};for(int p=0;p<N;p++)reach[p]=1;accumulateAverage(dcfr?t*t:t);
        if(threads==1){for(int d=0;d<D;d++)cfr(0,d,reach,threadDelta[0].data());}
        else{
          #pragma omp parallel for schedule(static)
          for(int d=0;d<D;d++)cfr(0,d,reach,threadDelta[omp_get_thread_num()].data());
        }
        const double positive=std::pow(double(iteration),1.5),positiveDiscount=positive/(positive+1);
        for(size_t i=0;i<cells;i++){double sum=0;for(int t=0;t<threads;t++)sum+=threadDelta[t][i];const double r=regrets[i]+sum;regrets[i]=dcfr?r*(r>0?positiveDiscount:.5):std::max(0.0,r);}
      }
      if(iteration%checkEvery==0||iteration==maxIterations||seconds()>=maxSeconds){
        policies(true);diag=diagnostics();std::cout<<json({{"phase","solving"},{"iteration",iteration},{"seconds",seconds()},{"nashConv",diag["nashConv"]},{"nashConvPctPot",diag["nashConvPctPot"]},{"optimizationResidualPctPot",diag["optimizationResidualPctPot"]},{"residualForStopping",diag["residualForStopping"]}}).dump()<<std::endl;
        if(!in["accuracy"].is_null()&&iteration>delay&&diag["optimizationResidualPctPot"].get<double>()<=in["accuracy"].get<double>()){reason="target_residual_reached";break;}
        if(seconds()>=maxSeconds){reason="time_limit";break;}
      }
    }
    iteration=std::min(iteration,maxIterations);policies(true);if(diag.is_null())diag=diagnostics();
    json result;result["schemaVersion"]=1;result["implementationVersion"]="1.2.1";result["units"]="BB";result["engine"]="RiverLab exact CFR+";result["status"]="complete";result["stopReason"]=reason;result["diagnostics"]=diag;result["rakeModel"]=in.value("rakeModel",json({{"type","none"},{"fixedRake",fixedRake},{"grossStartingPot",pot},{"netStartingPot",pot-fixedRake}}));result["diagnostics"]["constantSum"]=pot-fixedRake;
    json out=json::array();for(size_t i=0;i<nodes.size();i++)out.push_back(nullptr);std::vector<Values> reach(D);for(auto &r:reach)for(int p=0;p<N;p++)r[p]=1;reportNode(0,reach,out);result["nodes"]=std::move(out);
    int leaves=0,infosets=0;for(auto &n:nodes)if(n.actor<0)leaves++;else infosets+=n.combos;
    const bool sampled=in.contains("chance")&&!in["chance"].value("exact",true);
    result["chance"]=in.value("chance",json({{"mode","exact"},{"exact",true}}));
    result["stats"]={{"iterations",iteration},{"seconds",seconds()},{"publicNodes",nodes.size()},{"terminalNodes",leaves},{"legalDeals",D},{"infoSets",infosets},{"strategyCells",cells},{"algorithm",dcfr?"Simultaneous DCFR(1.5,0,2); quadratic average after delay":"Simultaneous CFR+; linearly weighted average after delay"},{"chanceSampling",sampled},{"precision","float64"},{"threads",threads},{"zeroReachPruning",zeroReachPruning},{"averagedIterations",std::max(0,iteration-delay)}};
    result["stats"]["terminalCacheBytes"]=terminal.size()*sizeof(double);result["stats"]["terminalValuesPerDeal"]=N;
    if(dcfr)result["engine"]="RiverLab exact DCFR";
    if(alternating){result["engine"]="RiverLab exact alternating CFR+";result["stats"]["algorithm"]="Alternating CFR+; one regret update per player per iteration; linear average after each full round";}result["stats"]["playerUpdatePasses"]=iteration*(alternating?N:1);
    result["assumptions"]={"River only, five public cards fixed. Independent input ranges conditioned jointly on legal card combinations.","Dead starting pot is eligible to every entered player; no carried-over side pots. Current-street side pots and uncalled-bet refunds are exact.","Continuous chips: tied pots split fractionally; no casino odd-chip allocation. See rakeModel for the explicitly modeled fixed fee.","Action sizes and raise cap are a finite abstraction, not all legal no-limit actions. EVs are relative to the current node, excluding sunk contributions.","Ranges describe all players still in the pot. Folded-card bunching is not modeled."};
    if(fixedRake>0)result["assumptions"].push_back("The initial pot is gross, with the capped rake not yet removed. Its supplied rate already reaches the supplied cap at the root; this cap is deducted once from the common starting pot at every terminal. Gross pots size bets; later chips and uncalled refunds are not raked again.");
    result["limits"]={"Multiplayer CFR has no general Nash-equilibrium convergence guarantee.","NashConv is measured only within the chosen action tree; omitted sizes can create additional real-game exploits.","Locked strategies can make the unrestricted best-response residual irreducible. BR metrics deliberately allow deviations from locks.","A small residual certifies a strategy profile for this stated model, not the correctness of the input ranges or real-world profitability."};
    if(sampled){result["engine"]=std::string("RiverLab sampled-chance ")+(dcfr?"DCFR":alternating?"alternating CFR+":"CFR+");result["diagnostics"]["verifiedBy"]="Information-set-consistent exact best response within the empirical training chance distribution";result["limits"].push_back("Chance is sampled. Training NashConv does not measure the full original range game; independent holdout residuals are diagnostics, not certified upper bounds.");result["validation"]["holdout"]=holdout();result["stats"]["seconds"]=seconds();}
    if(evaluationOnly){result["engine"]="RiverLab independent exact policy evaluator";result["evaluationOnly"]=true;result["stats"]["algorithm"]="Given complete policy; no training; unrestricted information-set best response";}
    return result;
  }
};
int main(int argc,char** argv){try{if(argc!=3){std::cerr<<"Usage: river-engine input.json output.json\n";return 2;}std::ifstream f(argv[1]);json input;f>>input;Engine engine(std::move(input));auto result=engine.run();std::ofstream output(argv[2]);output<<result.dump();return 0;}catch(const std::exception &e){std::cerr<<e.what()<<std::endl;return 1;}}
