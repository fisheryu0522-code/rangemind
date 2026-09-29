// Appended to equity.cu at compilation. Samples joint product ranges conditional on card compatibility.
extern "C" __global__ void multi_equity(const int *hands,const double *cdf,const int *offsets,int players,const int *board,int nc,unsigned seed,int n,int *winnerMasks,int *chosen){
  int idx=blockIdx.x*blockDim.x+threadIdx.x;if(idx>=n)return;
  unsigned state=mix((idx+1)^seed);int selected[9]={0};unsigned long long base=0;
  for(int i=0;i<nc;i++)base|=1ULL<<board[i];
  unsigned long long used=base;bool ok=false;
  for(int attempt=0;attempt<20000;attempt++){
    used=base;bool valid=true;
    for(int p=0;p<players;p++){
      int start=offsets[p],count=offsets[p+1]-start;
      int j=start+pick(cdf+start,count,state);selected[p]=j;
      unsigned long long bits=(1ULL<<hands[2*j])|(1ULL<<hands[2*j+1]);
      if(used&bits){valid=false;break;}used|=bits;
    }
    if(valid){ok=true;break;}
  }
  if(!ok){winnerMasks[idx]=-1;return;}
  int runout[5]={0};for(int i=0;i<nc;i++)runout[i]=board[i];
  for(int i=nc;i<5;i++){
    int c;do{unsigned r;do{r=rnd(state);}while(r>=4294967248U);c=r%52;}while(used&(1ULL<<c));
    used|=1ULL<<c;runout[i]=c;
  }
  int best=-1,mask=0;
  for(int p=0;p<players;p++){
    int cs[7]={0};for(int i=0;i<5;i++)cs[i]=runout[i];cs[5]=hands[2*selected[p]];cs[6]=hands[2*selected[p]+1];
    int rank=evaluate(cs);if(rank>best){best=rank;mask=1<<p;}else if(rank==best)mask|=1<<p;
    chosen[idx*players+p]=selected[p];
  }
  winnerMasks[idx]=mask;
}
