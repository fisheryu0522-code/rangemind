// PokerLab TurnLab — exact turn-to-river imperfect-information tree solver.
// Original implementation, 2026. JSON parser: nlohmann/json (MIT), see json.hpp.
#include "../RiverLab/json.hpp"
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
using Values=std::array<double,4>;
struct Deal { std::array<int,4> hands{},ranks{}; int river=-1,riverLocal=-1; double weight=0; };
struct Node { int actor=-1,parent=-1,parentAction=-1,leaf=-1,group=0; std::vector<int> children,riverCards,riverLookup; std::vector<double> contrib; std::vector<bool> folded; size_t offset=0,leafOffset=0; int combos=0; bool constant=false; };

class Engine {
public:
  json in; int N=0,D=0,iteration=0,threads=1; double pot=0,fixedRake=0; size_t cells=0,payoffCells=0; std::vector<Deal> deals; std::vector<Node> nodes;std::vector<std::vector<int>> groups;
  bool zeroReachPruning=true,dcfr=false,alternating=false,evaluationOnly=false;
  std::vector<double> terminal; std::vector<double> regrets,average,strategy; std::vector<bool> fixed;
  std::chrono::steady_clock::time_point started=std::chrono::steady_clock::now();
  explicit Engine(json input):in(std::move(input)) {
    N=in["players"].size();if(N<2||N>4)throw std::runtime_error("TurnLab supports two to four players.");pot=in["pot"].get<double>();fixedRake=in.value("fixedRake",0.0);if(!std::isfinite(fixedRake)||fixedRake<0||fixedRake>pot)throw std::runtime_error("Invalid fixed rake.");evaluationOnly=in.value("evaluationOnly",false);zeroReachPruning=in.value("zeroReachPruning",true);dcfr=in.value("algorithm",std::string("cfr-plus"))=="dcfr";alternating=in.value("algorithm",std::string("cfr-plus"))=="alternating-cfr-plus";
    for(auto &d:in["deals"]){Deal v;for(int p=0;p<N;p++){v.hands[p]=d["hands"][p];v.ranks[p]=d["ranks"][p];}v.river=d.value("river",-1);v.weight=d["weight"];deals.push_back(v);}D=deals.size();in["deals"]=nullptr;
    int leaf=0;
    for(auto &j:in["nodes"]){Node n;n.actor=j["actor"];n.contrib=j["contributions"].get<std::vector<double>>();n.folded=j["folded"].get<std::vector<bool>>();if(n.actor==-1){n.leaf=leaf++;n.constant=std::count(n.folded.begin(),n.folded.end(),false)==1;}else {for(auto &a:j["actions"]){n.children.push_back(a["child"]);if(n.actor==-2)n.riverCards.push_back(a["card"]);}if(n.actor==-2){n.riverLookup.assign(52,-1);for(int a=0;a<int(n.riverCards.size());a++)n.riverLookup[n.riverCards[a]]=a;}if(n.actor>=0){n.combos=in["combinations"][n.actor].size();n.offset=cells;cells+=n.combos*n.children.size();}}nodes.push_back(n);}
    groups.resize(53);for(int d=0;d<D;d++){groups[0].push_back(d);if(deals[d].river>=0){auto &group=groups[deals[d].river+1];deals[d].riverLocal=group.size();group.push_back(d);}}
    assignGroup(0,0);for(auto &n:nodes)if(n.actor==-1){n.leafOffset=payoffCells;payoffCells+=n.constant?1:groups[n.group].size();}
    if(payoffCells*N>750000000||cells>20000000)throw std::runtime_error("Exact engine memory budget exceeded. Reduce ranges or action sizes.");
    for(size_t i=0;i<nodes.size();i++)for(size_t a=0;a<nodes[i].children.size();a++){auto &c=nodes[nodes[i].children[a]];c.parent=i;c.parentAction=a;}
    threads=std::min(in.value("threads",1),std::max(1,int(128000000/std::max(size_t(1),cells))));if(size_t(D)*nodes.size()<100000)threads=1;omp_set_num_threads(threads);
    terminal.resize(payoffCells*N);regrets.assign(cells,0);average.assign(cells,0);strategy.assign(cells,0);fixed.assign(cells,false);
    #pragma omp parallel for schedule(dynamic,1)
    for(int i=0;i<int(nodes.size());i++){const Node &n=nodes[i];if(n.actor==-1){const auto &ids=groups[n.group];if(n.constant)storeTerminal(n,ids.empty()?0:ids[0],0);else for(size_t local=0;local<ids.size();local++)storeTerminal(n,ids[local],local);}}
    policies(false);
    if(evaluationOnly)for(const auto &n:nodes)if(n.actor>=0)for(int c=0;c<n.combos;c++)if(!fixed[n.offset+c*n.children.size()])throw std::runtime_error("Policy evaluation requires a complete locked policy at every information set.");
  }
  double seconds() const {return std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count();}
  void assignGroup(int id,int group){auto &n=nodes[id];n.group=group;for(int a=0;a<int(n.children.size());a++)assignGroup(n.children[a],n.actor==-2?n.riverCards[a]+1:group);}
  int chanceAction(const Node &n,int d) const {const int river=deals[d].river;if(river>=0&&n.riverLookup[river]>=0)return n.riverLookup[river];throw std::runtime_error("Missing legal public river chance branch.");}
  Values terminalValue(const Node &n,int d) const {Values v{};const size_t offset=(n.leafOffset+(n.constant?0:n.group==0?d:deals[d].riverLocal))*N;for(int p=0;p<N;p++)v[p]=terminal[offset+p];return v;}
  void storeTerminal(const Node &n,int d,size_t local){const auto v=payoff(n,deals[d]);const size_t offset=(n.leafOffset+(n.constant?0:local))*N;for(int p=0;p<N;p++)terminal[offset+p]=v[p];}
  Values payoff(const Node &node,const Deal &deal) const {
    Values result{};for(int p=0;p<N;p++)result[p]=-node.contrib[p];
    auto award=[&](double amount,const std::vector<int>& eligible){if(amount<=0)return;if(eligible.empty())throw std::runtime_error("Side pot without eligible player.");int best=-1,count=0;for(int p:eligible)best=std::max(best,deal.ranks[p]);for(int p:eligible)if(deal.ranks[p]==best)count++;for(int p:eligible)if(deal.ranks[p]==best)result[p]+=amount/count;};
    std::vector<int> alive;for(int p=0;p<N;p++)if(!node.folded[p])alive.push_back(p);award(pot-fixedRake,alive);
    std::vector<double> levels=node.contrib;std::sort(levels.begin(),levels.end());levels.erase(std::unique(levels.begin(),levels.end()),levels.end());double last=0;
    for(double level:levels){if(level<=last+1e-9)continue;std::vector<int> contributors,eligible;for(int p=0;p<N;p++)if(node.contrib[p]>=level-1e-9){contributors.push_back(p);if(!node.folded[p])eligible.push_back(p);}const double amount=(level-last)*contributors.size();if(contributors.size()==1)result[contributors[0]]+=amount;else award(amount,eligible);last=level;}
    return result;
  }
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
    const Node &n=nodes[id];if(n.actor==-1)return terminalValue(n,d);if(n.actor==-2)return cfr(n.children[chanceAction(n,d)],d,reach,regretDelta);
    const int p=n.actor,A=n.children.size(),combo=deals[d].hands[p];const size_t off=n.offset+combo*A;
    std::array<Values,8> child{};Values value{};
    for(int a=0;a<A;a++){auto r=reach;r[p]*=strategy[off+a];child[a]=cfr(n.children[a],d,r,regretDelta);for(int k=0;k<N;k++)value[k]+=strategy[off+a]*child[a][k];}
    double counterfactual=deals[d].weight;for(int k=0;k<N;k++)if(k!=p)counterfactual*=reach[k];
    for(int a=0;a<A;a++)regretDelta[off+a]+=counterfactual*(child[a][p]-value[p]);
    return value;
  }
  double cfrPlayer(int id,int d,int player,double counterfactualReach,double *regretDelta){
    if(zeroReachPruning&&counterfactualReach==0)return 0;
    const Node &n=nodes[id];if(n.actor==-1)return terminalValue(n,d)[player];if(n.actor==-2)return cfrPlayer(n.children[chanceAction(n,d)],d,player,counterfactualReach,regretDelta);
    const int A=n.children.size();const size_t off=n.offset+deals[d].hands[n.actor]*A;double value=0;
    if(n.actor==player){std::array<double,8> child{};for(int a=0;a<A;a++){child[a]=cfrPlayer(n.children[a],d,player,counterfactualReach,regretDelta);value+=strategy[off+a]*child[a];}for(int a=0;a<A;a++)regretDelta[off+a]+=counterfactualReach*(child[a]-value);}
    else for(int a=0;a<A;a++){const double probability=strategy[off+a];if(probability>0||!zeroReachPruning)value+=probability*cfrPlayer(n.children[a],d,player,counterfactualReach*probability,regretDelta);}
    return value;
  }
  // A single action is selected for every hidden deal sharing the acting
  // player's hand and public history. Opponent private cards never enter the
  // maximization key. This is the essential information-set BR constraint.
  std::vector<double> bestResponse(int id,int player,const std::vector<double> &counterfactualReach,bool respectLocks=false) const {
    const Node &n=nodes[id];const auto &ids=groups[n.group];const int L=ids.size();std::vector<double> value(L,0);
    if(n.actor==-1){for(int local=0;local<L;local++)value[local]=terminalValue(n,ids[local])[player];return value;}
    if(n.actor==-2){for(int a=0;a<int(n.children.size());a++){const auto &subIds=groups[n.riverCards[a]+1];std::vector<double> reach(subIds.size());for(size_t local=0;local<subIds.size();local++)reach[local]=counterfactualReach[subIds[local]];auto child=bestResponse(n.children[a],player,reach,respectLocks);for(size_t local=0;local<subIds.size();local++)value[subIds[local]]=child[local];}return value;}
    const int A=n.children.size();std::vector<std::vector<double>> child;child.reserve(A);
    for(int a=0;a<A;a++){auto reach=counterfactualReach;if(n.actor!=player)for(int local=0;local<L;local++)reach[local]*=strategy[n.offset+deals[ids[local]].hands[n.actor]*A+a];child.push_back(bestResponse(n.children[a],player,reach,respectLocks));}
    if(n.actor==player){
      std::vector<double> totals(size_t(n.combos)*A,0);for(int local=0;local<L;local++)for(int a=0;a<A;a++)totals[deals[ids[local]].hands[player]*A+a]+=counterfactualReach[local]*child[a][local];
      std::vector<int> best(n.combos,0);for(int c=0;c<n.combos;c++)for(int a=1;a<A;a++)if(totals[c*A+a]>totals[c*A+best[c]])best[c]=a;
      for(int local=0;local<L;local++){const int c=deals[ids[local]].hands[player];if(respectLocks&&fixed[n.offset+c*A])for(int a=0;a<A;a++)value[local]+=strategy[n.offset+c*A+a]*child[a][local];else value[local]=child[best[c]][local];}
    }else for(int local=0;local<L;local++)for(int a=0;a<A;a++)value[local]+=strategy[n.offset+deals[ids[local]].hands[n.actor]*A+a]*child[a][local];
    return value;
  }
  Values profile(int id,int d) const {const Node &n=nodes[id];if(n.actor==-1)return terminalValue(n,d);if(n.actor==-2)return profile(n.children[chanceAction(n,d)],d);Values v{};int A=n.children.size();for(int a=0;a<A;a++){const auto child=profile(n.children[a],d);const double probability=strategy[n.offset+deals[d].hands[n.actor]*A+a];for(int p=0;p<N;p++)v[p]+=probability*child[p];}return v;}
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
  // Exact counterfactual conditional action values and full-joint node reaches.
  // Descendant EVs always use the reported average strategy, not a BR policy.
  std::vector<Values> reportNode(int id,const std::vector<Values>& reach,json &output) const {
    const Node &n=nodes[id];const auto &ids=groups[n.group];const int L=ids.size();std::vector<Values> value(L);
    json j=in["nodes"][id];j.erase("lastFullRaise");j.erase("currentBet");j.erase("raises");
    double nodeReach=0;for(int local=0;local<L;local++){double r=deals[ids[local]].weight;for(int p=0;p<N;p++)r*=reach[local][p];nodeReach+=r;}j["reach"]=nodeReach;
    if(n.actor==-1){Values expected{};for(int local=0;local<L;local++){value[local]=terminalValue(n,ids[local]);double r=deals[ids[local]].weight;for(int p=0;p<N;p++)r*=reach[local][p];for(int p=0;p<N;p++)expected[p]+=r*(value[local][p]+n.contrib[p]);}j["expectedAward"]=json::array();for(int p=0;p<N;p++)j["expectedAward"].push_back(nodeReach>1e-100?json(expected[p]/nodeReach):json(nullptr));j["combos"]=json::array();output[id]=std::move(j);return value;}
    if(n.actor==-2){j["combos"]=json::array();for(int a=0;a<int(n.children.size());a++){const auto &subIds=groups[n.riverCards[a]+1];std::vector<Values> r(subIds.size());double branchReach=0;for(size_t local=0;local<subIds.size();local++){const int d=subIds[local];r[local]=reach[d];double probability=deals[d].weight;for(int p=0;p<N;p++)probability*=r[local][p];branchReach+=probability;}auto child=reportNode(n.children[a],r,output);for(size_t local=0;local<subIds.size();local++)value[subIds[local]]=child[local];j["actions"][a].erase("child");j["actions"][a]["frequency"]=nodeReach>1e-100?json(branchReach/nodeReach):json(nullptr);j["actions"][a]["ev"]=nullptr;}output[id]=std::move(j);return value;}
    const int p=n.actor,A=n.children.size();std::vector<std::vector<Values>> child;child.reserve(A);
    for(int a=0;a<A;a++){auto r=reach;for(int local=0;local<L;local++)r[local][p]*=strategy[n.offset+deals[ids[local]].hands[p]*A+a];child.push_back(reportNode(n.children[a],r,output));}
    std::vector<double> denom(n.combos,0),joint(n.combos,0),ev(size_t(n.combos)*A,0);std::vector<double> actionMass(A,0),actionValue(A,0),selectedValue(A,0);j["combos"]=json::array();
    for(int local=0;local<L;local++){
      const int d=ids[local];double cf=deals[d].weight,full=deals[d].weight;for(int k=0;k<N;k++){full*=reach[local][k];if(k!=p)cf*=reach[local][k];}int c=deals[d].hands[p];denom[c]+=cf;joint[c]+=full;
      for(int a=0;a<A;a++){const double s=strategy[n.offset+c*A+a];ev[c*A+a]+=cf*(child[a][local][p]+n.contrib[p]);actionMass[a]+=full*s;actionValue[a]+=full*(child[a][local][p]+n.contrib[p]);selectedValue[a]+=full*s*(child[a][local][p]+n.contrib[p]);for(int k=0;k<N;k++)value[local][k]+=s*child[a][local][k];}
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
    json result;result["schemaVersion"]=1;result["implementationVersion"]="1.3.0";result["units"]="BB";result["engine"]="TurnLab exact two-street CFR+";result["status"]="complete";result["stopReason"]=reason;result["diagnostics"]=diag;result["rakeModel"]=in.value("rakeModel",json({{"type","none"},{"fixedRake",fixedRake},{"grossStartingPot",pot},{"netStartingPot",pot-fixedRake}}));result["diagnostics"]["constantSum"]=pot-fixedRake;
    json out=json::array();for(size_t i=0;i<nodes.size();i++)out.push_back(nullptr);std::vector<Values> reach(D);for(auto &r:reach)for(int p=0;p<N;p++)r[p]=1;reportNode(0,reach,out);result["nodes"]=std::move(out);
    int leaves=0,infosets=0,chanceNodes=0;for(auto &n:nodes)if(n.actor==-1)leaves++;else if(n.actor==-2)chanceNodes++;else infosets+=n.combos;
    const bool sampled=in.contains("chance")&&!in["chance"].value("exact",true);
    result["chance"]=in.value("chance",json({{"mode","exact"},{"exact",true}}));
    result["stats"]={{"iterations",iteration},{"seconds",seconds()},{"publicNodes",nodes.size()},{"terminalNodes",leaves},{"legalDeals",D},{"infoSets",infosets},{"strategyCells",cells},{"algorithm",dcfr?"Simultaneous DCFR(1.5,0,2); quadratic average after delay":"Simultaneous CFR+; linearly weighted average after delay"},{"chanceSampling",sampled},{"precision","float64"},{"threads",threads},{"zeroReachPruning",zeroReachPruning},{"averagedIterations",std::max(0,iteration-delay)}};
    if(dcfr)result["engine"]="TurnLab exact two-street DCFR";
    if(alternating){result["engine"]="TurnLab exact two-street alternating CFR+";result["stats"]["algorithm"]="Alternating CFR+; one regret update per player per iteration; linear average after each full round";}result["stats"]["playerUpdatePasses"]=iteration*(alternating?N:1);
    result["stats"]["chanceNodes"]=chanceNodes;result["stats"]["payoffCells"]=payoffCells;result["stats"]["payoffMemoryBytes"]=payoffCells*N*sizeof(double);result["stats"]["chanceGrouping"]="Exact per-public-river deal groups; no card or hand abstraction";
    result["assumptions"]={"Two genuine betting streets: turn and river. Future river is hidden during turn decisions and only enters the information set after the public chance transition.","Independent input ranges conditioned jointly on legal cards. Every possible future river is weighted exactly, including cards held by players who subsequently fold.","Dead starting pot is eligible to every entered player; no carried-over side pots. Contributions across both streets form exact side pots and uncalled-bet refunds.","Continuous chips: tied pots split fractionally; no casino odd-chip allocation. See rakeModel for the explicitly modeled fixed fee.","Action sizes and raise caps are a finite abstraction, not all legal no-limit actions. EVs include future river decisions and exclude contributions sunk before the selected node.","Ranges describe all players still in the pot. Previously folded-card bunching is not modeled."};
    if(fixedRake>0)result["assumptions"].push_back("The initial pot is gross, with the capped rake not yet removed. Its supplied rate already reaches the supplied cap at the root; this cap is deducted once from the common starting pot at every terminal. Gross pots size bets; later chips and uncalled refunds are not raked again.");
    result["limits"]={"Multiplayer CFR has no general Nash-equilibrium convergence guarantee.","NashConv is measured only within the chosen action tree; omitted sizes can create additional real-game exploits.","Locked strategies can make the unrestricted best-response residual irreducible. BR metrics deliberately allow deviations from locks.","A small residual certifies a strategy profile for this stated model, not the correctness of the input ranges or real-world profitability."};
    if(evaluationOnly){result["engine"]="TurnLab independent exact policy evaluator";result["evaluationOnly"]=true;result["stats"]["algorithm"]="Given complete policy; no training; unrestricted information-set best response";}
    return result;
  }
};
int main(int argc,char** argv){try{if(argc!=3){std::cerr<<"Usage: river-engine input.json output.json\n";return 2;}std::ifstream f(argv[1]);json input;f>>input;Engine engine(std::move(input));auto result=engine.run();std::ofstream output(argv[2]);output<<result.dump();return 0;}catch(const std::exception &e){std::cerr<<e.what()<<std::endl;return 1;}}
