"""RTX 4090 multi-player equity; independent rejection sampling, no strategy claims."""
import ctypes as C, json, sys, pathlib, time, math, os
import numpy as np
from gpu import GPU, check, ROOT, P, I, U, Z

CI_METHOD='Empirical Bernstein · Maurer–Pontil 2009 Theorem 4 · two-sided pointwise 95%'

def sampling_interval(total,squares,n):
    if not n:return {'equity':None,'ci':None,'ciLow':None,'ciHigh':None}
    mean=float(total/n);log=math.log(4/.05)
    variance=max(0,float((squares-total*total/n)/(n-1))) if n>1 else 0
    radius=min(1,math.sqrt(2*variance*log/n)+7*log/(3*(n-1))) if n>1 else 1
    return {'equity':mean,'ci':radius,'ciLow':max(0,mean-radius),'ciHigh':min(1,mean+radius)}

def compile_multi(dll_path):
    dll_path=pathlib.Path(dll_path);handle=os.add_dll_directory(str(dll_path.parent))
    os.environ['PATH']=str(dll_path.parent)+os.pathsep+os.environ.get('PATH','')
    builtins=C.WinDLL(str(dll_path.parent/'nvrtc-builtins64_129.dll'));nv=C.WinDLL(str(dll_path))
    nv.nvrtcCreateProgram.argtypes=[C.POINTER(P),C.c_char_p,C.c_char_p,I,P,P]
    nv.nvrtcCompileProgram.argtypes=[P,I,C.POINTER(C.c_char_p)]
    nv.nvrtcGetProgramLogSize.argtypes=[P,C.POINTER(Z)];nv.nvrtcGetProgramLog.argtypes=[P,P]
    nv.nvrtcGetPTXSize.argtypes=[P,C.POINTER(Z)];nv.nvrtcGetPTX.argtypes=[P,P]
    nv.nvrtcDestroyProgram.argtypes=[C.POINTER(P)]
    source=(ROOT/'equity.cu').read_bytes()+b'\n'+(ROOT/'multi-equity.cu').read_bytes()
    prog=P();check(nv.nvrtcCreateProgram(C.byref(prog),source,b'multi-equity.cu',0,None,None))
    opts=(C.c_char_p*2)(b'--gpu-architecture=compute_89',b'--std=c++14');result=nv.nvrtcCompileProgram(prog,2,opts)
    size=Z();nv.nvrtcGetProgramLogSize(prog,C.byref(size));buf=C.create_string_buffer(size.value);nv.nvrtcGetProgramLog(prog,buf)
    if result:raise RuntimeError(buf.value.decode())
    check(nv.nvrtcGetPTXSize(prog,C.byref(size)));buf=C.create_string_buffer(size.value);check(nv.nvrtcGetPTX(prog,buf))
    (ROOT/'multi-equity.ptx').write_bytes(buf.raw);nv.nvrtcDestroyProgram(C.byref(prog));return {'compiled':True,'bytes':size.value}

class MultiGPU(GPU):
    def __init__(self):
        super().__init__();self.module=P();check(self.cuda.cuModuleLoad(C.byref(self.module),str(ROOT/'multi-equity.ptx').encode()))
    def multi(self,task):
        start=time.perf_counter();n=int(task.get('samples',1000000));seed=int(task.get('seed',20260928));ranges=task['ranges'];np_=len(ranges)
        if not 2<=np_<=9 or not 1000<=n<=10000000:raise ValueError('Invalid player/sample count')
        offsets=[0];hands=[];cdf=[]
        for rg in ranges:
            maximum=max(c['weight'] for c in rg)
            if maximum<=0 or any(not math.isfinite(c['weight']) or c['weight']<=0 for c in rg):raise ValueError('Invalid range weights')
            weights=[c['weight']/maximum for c in rg];mass=sum(weights);total=0
            for c,w in zip(rg,weights):
                hands.append(c['cards']);total+=w/mass;cdf.append(total)
            offsets.append(len(hands))
        nc=len(task['board']);board=np.array(task['board'] or [0],dtype=np.int32);hands=np.array(hands,dtype=np.int32);cdf=np.array(cdf,dtype=np.float64);offsets=np.array(offsets,dtype=np.int32)
        out=np.empty(n,dtype=np.int32);chosen=np.empty((n,np_),dtype=np.int32)
        hd=self.alloc(hands);cd=self.alloc(cdf);od=self.alloc(offsets);bd=self.alloc(board);result=self.alloc(out);ch=self.alloc(chosen)
        fn=P();check(self.cuda.cuModuleGetFunction(C.byref(fn),self.module,b'multi_equity'))
        args=[hd,cd,od,I(np_),bd,I(nc),U(seed),I(n),result,ch];params=(P*len(args))(*(C.cast(C.byref(x),P) for x in args))
        check(self.cuda.cuLaunchKernel(fn,(n+255)//256,1,1,256,1,1,0,None,params,None));check(self.cuda.cuCtxSynchronize())
        check(self.cuda.cuMemcpyDtoH_v2(out.ctypes.data,result,out.nbytes));check(self.cuda.cuMemcpyDtoH_v2(chosen.ctypes.data,ch,chosen.nbytes))
        for ptr in self.allocations:check(self.cuda.cuMemFree_v2(ptr))
        self.allocations=[]
        if np.any(out<0):raise ValueError('Ranges overlap too strongly for unbiased sampling; reduce overlap or use exact river enumeration')
        pop=np.array([i.bit_count() for i in range(1<<np_)],dtype=np.int32);ties=pop[out];players=[]
        for p in range(np_):
            won=(out&(1<<p))!=0;share=won.astype(np.float64)/ties
            indices=chosen[:,p]-offsets[p];count=offsets[p+1]-offsets[p]
            samples=np.bincount(indices,minlength=count);sums=np.bincount(indices,weights=share,minlength=count);squares=np.bincount(indices,weights=share*share,minlength=count)
            combo=[]
            for k in range(count):
                nk=int(samples[k]);combo.append({**sampling_interval(float(sums[k]),float(squares[k]),nk),'samples':nk,'reach':nk/n})
            players.append({**sampling_interval(float(np.sum(share)),float(np.sum(share*share)),n),'tieProbability':float(np.mean(won&(ties>1))),'combos':[] if task.get('summaryOnly') else combo})
        return {'players':players,'samples':n,'exact':False,'ciMethod':CI_METHOD,'ciLevel':.95,'ciCoverage':'pointwise','ciSource':'https://www.cs.mcgill.ca/~colt2009/papers/012.pdf','seed':seed,'engine':self.name+' · CUDA 多人权益','milliseconds':round((time.perf_counter()-start)*1000,2)}
if __name__=='__main__':
    try:
        if len(sys.argv)>1 and sys.argv[1]=='compile':result=compile_multi(sys.argv[2])
        else:
            data=json.load(sys.stdin);gpu=MultiGPU()
            try:
                results=[]
                for i,t in enumerate(data['tasks']):
                    results.append(gpu.multi(t))
                    if data.get('progress'):print(json.dumps({'completed':i+1,'total':len(data['tasks'])}),file=sys.stderr,flush=True)
                result={'results':results}
            finally:gpu.close()
        print(json.dumps(result,ensure_ascii=True))
    except Exception as e:print(json.dumps({'error':str(e)}));sys.exit(1)
