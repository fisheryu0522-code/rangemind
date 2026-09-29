// PokerLab experimental FP64 exact-chance simultaneous CFR+.
// Original implementation. No Monte Carlo sampling and no hidden-card BR.
// The same policy is held fixed across every deal in an iteration.
extern "C" __global__ void policy(
 int infosets,const int* infoNode,const int* infoCombo,const int* actions,
 const int* offsets,const double* regrets,const double* average,
 const int* locked,const double* lockedPolicy,double* strategy,int useAverage){
 int i=blockIdx.x*blockDim.x+threadIdx.x;if(i>=infosets)return;
 int n=infoNode[i],A=actions[n],off=offsets[n]+infoCombo[i]*A;double sum=0;
 for(int a=0;a<A;a++)sum+=fmax(0.0,useAverage?average[off+a]:regrets[off+a]);
 for(int a=0;a<A;a++)strategy[off+a]=locked[i]?lockedPolicy[off+a]:sum>1e-100?fmax(0.0,useAverage?average[off+a]:regrets[off+a])/sum:1.0/A;
}

extern "C" __global__ void initialize_payoffs(
 int D,int N,int M,double pot,const int* actors,const double* contributions,
 const int* folded,const int* ranks,double* values){
 int d=blockIdx.x*blockDim.x+threadIdx.x;if(d>=D)return;
 for(int n=0;n<M;n++)if(actors[n]<0){
  double out[3];for(int p=0;p<N;p++)out[p]=-contributions[n*N+p];
  int best=-1,winners=0;for(int p=0;p<N;p++)if(!folded[n*N+p])best=max(best,ranks[p*D+d]);
  for(int p=0;p<N;p++)if(!folded[n*N+p]&&ranks[p*D+d]==best)winners++;
  for(int p=0;p<N;p++)if(!folded[n*N+p]&&ranks[p*D+d]==best)out[p]+=pot/winners;
  double previous=0;
  for(int layer=0;layer<N;layer++){
   double next=1e300;for(int p=0;p<N;p++)if(contributions[n*N+p]>previous+1e-9)next=fmin(next,contributions[n*N+p]);
   if(next==1e300)break;int entrants=0,only=-1;best=-1;winners=0;
   for(int p=0;p<N;p++)if(contributions[n*N+p]>=next-1e-9){entrants++;only=p;if(!folded[n*N+p])best=max(best,ranks[p*D+d]);}
   double amount=(next-previous)*entrants;
   if(entrants==1)out[only]+=amount;
   else{for(int p=0;p<N;p++)if(contributions[n*N+p]>=next-1e-9&&!folded[n*N+p]&&ranks[p*D+d]==best)winners++;
    for(int p=0;p<N;p++)if(contributions[n*N+p]>=next-1e-9&&!folded[n*N+p]&&ranks[p*D+d]==best)out[p]+=amount/winners;}
   previous=next;
  }
  for(int p=0;p<N;p++)values[((long long)n*N+p)*D+d]=out[p];
 }
}

// A thread owns one complete private-card deal. Reverse preorder guarantees
// all child values are ready without inter-block barriers or atomics.
extern "C" __global__ void backward_values(
 int D,int N,int M,const int* actors,const int* actions,const int* edges,
 const int* edgeOffsets,const int* offsets,const int* hands,
 const double* strategy,double* values,int valuePlayer){
 int d=blockIdx.x*blockDim.x+threadIdx.x;if(d>=D)return;
 for(int n=M-1;n>=0;n--){int actor=actors[n];if(actor<0)continue;
  int A=actions[n],off=offsets[n]+hands[actor*D+d]*A;double v[3]={0,0,0};
  if(valuePlayer>=0){double scalar=0;for(int a=0;a<A;a++)scalar+=strategy[off+a]*values[((long long)edges[edgeOffsets[n]+a]*N+valuePlayer)*D+d];values[((long long)n*N+valuePlayer)*D+d]=scalar;}
  else{for(int a=0;a<A;a++){int child=edges[edgeOffsets[n]+a];double q=strategy[off+a];for(int p=0;p<N;p++)v[p]+=q*values[((long long)child*N+p)*D+d];}
   for(int p=0;p<N;p++)values[((long long)n*N+p)*D+d]=v[p];}
 }
}

// One deterministic reduction block per public-node/private-hand information
// set. Regret sums condition on all other players' reach and exact chance.
extern "C" __global__ void update_regrets(
 int D,int N,int infosets,int iteration,int averagingDelay,
 const int* infoNode,const int* infoCombo,const int* actors,const int* actions,
 const int* offsets,const int* edges,const int* edgeOffsets,
 const int* parents,const int* parentActions,const int* hands,
 const int* comboOffsets,const int* dealOffsets,const int* dealIndices,
 const double* chance,const double* strategy,const double* values,
 double* regrets,double* average,int dcfr,int updatePlayer,int addAverage){
 int info=blockIdx.x;if(info>=infosets)return;int n=infoNode[info],c=infoCombo[info],p=actors[n],A=actions[n],off=offsets[n]+c*A;
 if(updatePlayer>=0&&p!=updatePlayer)return;
 int group=comboOffsets[p]+c,begin=dealOffsets[group],end=dealOffsets[group+1];
 double sums[8]={0,0,0,0,0,0,0,0};
 for(int j=begin+threadIdx.x;j<end;j+=blockDim.x){int d=dealIndices[j];double cf=chance[d];int child=n;
  while(parents[child]>=0){int parent=parents[child],actor=actors[parent];if(actor!=p)cf*=strategy[offsets[parent]+hands[actor*D+d]*actions[parent]+parentActions[child]];child=parent;}
  double value=values[((long long)n*N+p)*D+d];
  for(int a=0;a<A;a++){int target=edges[edgeOffsets[n]+a];sums[a]+=cf*(values[((long long)target*N+p)*D+d]-value);}
 }
 __shared__ double scratch[256];
 for(int a=0;a<A;a++){
  scratch[threadIdx.x]=sums[a];__syncthreads();
  for(int stride=blockDim.x/2;stride>0;stride/=2){if(threadIdx.x<stride)scratch[threadIdx.x]+=scratch[threadIdx.x+stride];__syncthreads();}
  if(threadIdx.x==0){double r=regrets[off+a]+scratch[0];if(dcfr){double t=pow((double)iteration,1.5);r*=r>0?t/(t+1):.5;}else r=fmax(0.0,r);regrets[off+a]=r;}
  __syncthreads();
 }
 if(threadIdx.x==0&&addAverage){double t=fmax(0.0,(double)iteration-averagingDelay);if(dcfr)t*=t;double own=1;int child=n;
  while(parents[child]>=0){int parent=parents[child];if(actors[parent]==p)own*=strategy[offsets[parent]+c*actions[parent]+parentActions[child]];child=parent;}
  for(int a=0;a<A;a++)average[off+a]+=t*own*strategy[off+a];
 }
}

extern "C" __global__ void accumulate_average(
 int infosets,int iteration,int delay,const int* infoNode,const int* infoCombo,
 const int* actors,const int* actions,const int* offsets,const int* parents,
 const int* parentActions,const double* strategy,double* average){
 int i=blockIdx.x*blockDim.x+threadIdx.x;if(i>=infosets)return;
 int n=infoNode[i],c=infoCombo[i],p=actors[n],A=actions[n],off=offsets[n]+c*A,child=n;double own=1,t=fmax(0.0,(double)iteration-delay);
 while(parents[child]>=0){int parent=parents[child];if(actors[parent]==p)own*=strategy[offsets[parent]+c*actions[parent]+parentActions[child]];child=parent;}
 for(int a=0;a<A;a++)average[off+a]+=t*own*strategy[off+a];
}
