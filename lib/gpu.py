"""Local CUDA driver adapter; no network, telemetry, or third-party Python packages beyond numpy."""
import ctypes as C
import json, sys, pathlib, time, math
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parent
P=C.c_void_p; I=C.c_int; U=C.c_uint; Z=C.c_size_t; D=C.c_uint64
def check(code):
    if code: raise RuntimeError(f'CUDA error {code}')
def compile_ptx(dll_path):
    dll_path=pathlib.Path(dll_path)
    import os
    handle=os.add_dll_directory(str(dll_path.parent))
    os.environ['PATH']=str(dll_path.parent)+os.pathsep+os.environ.get('PATH','')
    builtins=C.WinDLL(str(dll_path.parent/'nvrtc-builtins64_129.dll'))
    nv=C.WinDLL(str(dll_path))
    nv.nvrtcCreateProgram.argtypes=[C.POINTER(P),C.c_char_p,C.c_char_p,I,P,P]
    nv.nvrtcCompileProgram.argtypes=[P,I,C.POINTER(C.c_char_p)]
    nv.nvrtcGetProgramLogSize.argtypes=[P,C.POINTER(Z)]
    nv.nvrtcGetProgramLog.argtypes=[P,P]
    nv.nvrtcGetPTXSize.argtypes=[P,C.POINTER(Z)]
    nv.nvrtcGetPTX.argtypes=[P,P]
    nv.nvrtcDestroyProgram.argtypes=[C.POINTER(P)]
    prog=P();check(nv.nvrtcCreateProgram(C.byref(prog),(ROOT/'equity.cu').read_bytes(),b'equity.cu',0,None,None))
    opts=(C.c_char_p*2)(b'--gpu-architecture=compute_89',b'--std=c++14')
    result=nv.nvrtcCompileProgram(prog,2,opts)
    size=Z();nv.nvrtcGetProgramLogSize(prog,C.byref(size));buf=C.create_string_buffer(size.value);nv.nvrtcGetProgramLog(prog,buf)
    if result: raise RuntimeError(buf.value.decode())
    check(nv.nvrtcGetPTXSize(prog,C.byref(size)));buf=C.create_string_buffer(size.value);check(nv.nvrtcGetPTX(prog,buf));(ROOT/'equity.ptx').write_bytes(buf.raw);nv.nvrtcDestroyProgram(C.byref(prog));return {'compiled':True,'bytes':size.value}
class GPU:
    def __init__(self):
        self.cuda=C.WinDLL('nvcuda.dll'); self.allocations=[]
        signatures={'cuInit':[U],'cuDeviceGet':[C.POINTER(I),I],'cuDeviceGetName':[P,I,I],'cuCtxCreate_v2':[C.POINTER(P),U,I],'cuModuleLoad':[C.POINTER(P),C.c_char_p],'cuModuleGetFunction':[C.POINTER(P),P,C.c_char_p],'cuMemAlloc_v2':[C.POINTER(D),Z],'cuMemcpyHtoD_v2':[D,P,Z],'cuMemcpyDtoH_v2':[P,D,Z],'cuMemFree_v2':[D],'cuLaunchKernel':[P,U,U,U,U,U,U,U,P,C.POINTER(P),P],'cuCtxSynchronize':[],'cuCtxDestroy_v2':[P]}
        for k,v in signatures.items():getattr(self.cuda,k).argtypes=v
        check(self.cuda.cuInit(0));dev=I();check(self.cuda.cuDeviceGet(C.byref(dev),0));name=C.create_string_buffer(128);check(self.cuda.cuDeviceGetName(name,128,dev));self.name=name.value.decode()
        self.ctx=P();check(self.cuda.cuCtxCreate_v2(C.byref(self.ctx),0,dev));self.module=P();check(self.cuda.cuModuleLoad(C.byref(self.module),str(ROOT/'equity.ptx').encode()))
    def alloc(self,array):
        ptr=D();check(self.cuda.cuMemAlloc_v2(C.byref(ptr),array.nbytes));self.allocations.append(ptr);check(self.cuda.cuMemcpyHtoD_v2(ptr,array.ctypes.data,array.nbytes));return ptr
    def launch(self,name,n,args,out,ptr):
        fn=P();check(self.cuda.cuModuleGetFunction(C.byref(fn),self.module,name.encode()));params=(P*len(args))(*(C.cast(C.byref(x),P) for x in args));check(self.cuda.cuLaunchKernel(fn,(n+255)//256,1,1,256,1,1,0,None,params,None));check(self.cuda.cuCtxSynchronize());check(self.cuda.cuMemcpyDtoH_v2(out.ctypes.data,ptr,out.nbytes))
        for x in self.allocations:check(self.cuda.cuMemFree_v2(x))
        self.allocations=[]
    def ranks(self,rows):
        arr=np.array(rows,dtype=np.int32);n=len(arr);out=np.empty(n,dtype=np.int32);a=self.alloc(arr);o=self.alloc(out);self.launch('ranks',n,[a,I(n),o],out,o);return out.tolist()
    def equity(self,task):
        start=time.perf_counter();n=int(task.get('samples',300000));seed=int(task.get('seed',20260928));board=np.array(task['board'],dtype=np.int32)
        a=np.array([c['cards'] for c in task['a']],dtype=np.int32);b=np.array([c['cards'] for c in task['b']],dtype=np.int32)
        aw=np.cumsum([c['weight'] for c in task['a']],dtype=np.float64);bw=np.cumsum([c['weight'] for c in task['b']],dtype=np.float64)
        out=np.empty(n,dtype=np.int32);ad=self.alloc(a);awd=self.alloc(aw);bd=self.alloc(b);bwd=self.alloc(bw);bboard=self.alloc(board);o=self.alloc(out)
        self.launch('equity',n,[ad,awd,I(len(a)),bd,bwd,I(len(b)),bboard,I(len(board)),U(seed),I(n),o],out,o)
        if np.any(out<0):raise RuntimeError('Range overlap prevented unbiased sampling; use narrower ranges.')
        win=int(np.sum(out==2));tie=int(np.sum(out==1));eq=(win+tie/2)/n;ci=1.96*math.sqrt(max(0,(win+tie/4)/n-eq*eq)/n)
        return {'equity':eq,'tie':tie/n,'ci':ci,'samples':n,'seed':seed,'exact':False,'engine':self.name+' · CUDA','milliseconds':round((time.perf_counter()-start)*1000,2)}
    def close(self):
        self.cuda.cuCtxDestroy_v2(self.ctx)
if __name__=='__main__':
    try:
        if len(sys.argv)>1 and sys.argv[1]=='compile':result=compile_ptx(sys.argv[2])
        else:
            data=json.load(sys.stdin);gpu=GPU()
            try:result={'ranks':gpu.ranks(data['ranks'])} if 'ranks' in data else {'results':[gpu.equity(t) for t in data['tasks']]}
            finally:gpu.close()
        print(json.dumps(result))
    except Exception as e:print(json.dumps({'error':str(e)}));sys.exit(1)
