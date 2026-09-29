// PokerLab seven-card evaluator and independent weighted Monte Carlo trials.
__device__ unsigned rnd(unsigned &s){s^=s<<13;s^=s>>17;s^=s<<5;return s;}
__device__ unsigned mix(unsigned x){x^=x>>16;x*=0x7feb352dU;x^=x>>15;x*=0x846ca68bU;x^=x>>16;return x?x:1;}
__device__ int st(unsigned m){for(int r=12;r>=4;r--)if((m&(31U<<(r-4)))==(31U<<(r-4)))return r+2;return (m&0x100f)==0x100f?5:0;}
__device__ int enc(int cat,int a=0,int b=0,int c=0,int d=0,int e=0){return (((((cat*15+a)*15+b)*15+c)*15+d)*15+e);}
__device__ __noinline__ int evaluate(const int *cards){
  int count[13]={0},suit[4]={0};unsigned masks[4]={0},mask=0;
  for(int i=0;i<7;i++){int r=cards[i]/4,s=cards[i]%4;count[r]++;suit[s]++;masks[s]|=1U<<r;mask|=1U<<r;}
  int fl=-1;for(int s=0;s<4;s++)if(suit[s]>=5)fl=s;
  if(fl>=0){int x=st(masks[fl]);if(x)return enc(8,x);}
  int four=0,trip=0,pairs[3]={0},np=0,rs[7],nr=0;
  for(int r=12;r>=0;r--){if(count[r])rs[nr++]=r+2;if(count[r]==4)four=r+2;if(count[r]>=3&&!trip)trip=r+2;if(count[r]>=2)pairs[np++]=r+2;}
  if(four){int k=0;for(int i=0;i<nr;i++)if(rs[i]!=four){k=rs[i];break;}return enc(7,four,k);}
  if(trip&&np>=2){int p=pairs[0]==trip?pairs[1]:pairs[0];return enc(6,trip,p);}
  if(fl>=0){int v[5],n=0;for(int r=12;r>=0&&n<5;r--)if(masks[fl]&(1U<<r))v[n++]=r+2;return enc(5,v[0],v[1],v[2],v[3],v[4]);}
  int x=st(mask);if(x)return enc(4,x);
  if(trip){int v[2],n=0;for(int i=0;i<nr&&n<2;i++)if(rs[i]!=trip)v[n++]=rs[i];return enc(3,trip,v[0],v[1]);}
  if(np>=2){int k=0;for(int i=0;i<nr;i++)if(rs[i]!=pairs[0]&&rs[i]!=pairs[1]){k=rs[i];break;}return enc(2,pairs[0],pairs[1],k);}
  if(np){int v[3],n=0;for(int i=0;i<nr&&n<3;i++)if(rs[i]!=pairs[0])v[n++]=rs[i];return enc(1,pairs[0],v[0],v[1],v[2]);}
  return enc(0,rs[0],rs[1],rs[2],rs[3],rs[4]);
}
__device__ int pick(const double *cdf,int n,unsigned &state){double x=(rnd(state)+0.5)*(1.0/4294967296.0)*cdf[n-1];int l=0,h=n-1;while(l<h){int m=(l+h)/2;if(x<cdf[m])h=m;else l=m+1;}return l;}
extern "C" __global__ void equity(const int *a,const double *aw,int na,const int *b,const double *bw,int nb,const int *board,int nc,unsigned seed,int n,int *out){
  int idx=blockIdx.x*blockDim.x+threadIdx.x;if(idx>=n)return;unsigned state=mix((idx+1)^seed);int ai=0,bi=0;bool ok=false;
  for(int k=0;k<10000;k++){ai=pick(aw,na,state);bi=pick(bw,nb,state);if(a[ai*2]!=b[bi*2]&&a[ai*2]!=b[bi*2+1]&&a[ai*2+1]!=b[bi*2]&&a[ai*2+1]!=b[bi*2+1]){ok=true;break;}}
  if(!ok){out[idx]=-1;return;}
  int ac[7]={0},bc[7]={0};unsigned long long used=0;for(int i=0;i<nc;i++){ac[i]=bc[i]=board[i];used|=1ULL<<board[i];}
  ac[5]=a[ai*2];ac[6]=a[ai*2+1];bc[5]=b[bi*2];bc[6]=b[bi*2+1];used|=(1ULL<<ac[5])|(1ULL<<ac[6])|(1ULL<<bc[5])|(1ULL<<bc[6]);
  for(int i=nc;i<5;i++){int c;do{unsigned r;do{r=rnd(state);}while(r>=4294967248U);c=r%52;}while(used&(1ULL<<c));used|=1ULL<<c;ac[i]=bc[i]=c;}
  int ar=evaluate(ac),br=evaluate(bc);out[idx]=ar>br?2:(ar==br?1:0);
}
extern "C" __global__ void ranks(const int *cs,int n,int *out){int i=blockIdx.x*blockDim.x+threadIdx.x;if(i<n)out[i]=evaluate(cs+i*7);}
