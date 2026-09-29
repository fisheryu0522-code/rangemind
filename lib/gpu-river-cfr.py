"""Independent experimental full-chance FP64 CUDA CFR+ / DCFR.

No output is presented as verified game quality until a separate CPU
information-set-consistent unrestricted best response evaluates this policy.
"""
import ctypes as C, json, pathlib, sys, os, time, hashlib
import numpy as np
from gpu import GPU, check, ROOT, P, I, U, Z, D

def compile_kernel(dll_path):
    dll_path=pathlib.Path(dll_path);handle=os.add_dll_directory(str(dll_path.parent))
    os.environ['PATH']=str(dll_path.parent)+os.pathsep+os.environ.get('PATH','')
    builtins=C.WinDLL(str(dll_path.parent/'nvrtc-builtins64_129.dll'));nv=C.WinDLL(str(dll_path))
    nv.nvrtcCreateProgram.argtypes=[C.POINTER(P),C.c_char_p,C.c_char_p,I,P,P]
    nv.nvrtcCompileProgram.argtypes=[P,I,C.POINTER(C.c_char_p)]
    nv.nvrtcGetProgramLogSize.argtypes=[P,C.POINTER(Z)];nv.nvrtcGetProgramLog.argtypes=[P,P]
    nv.nvrtcGetPTXSize.argtypes=[P,C.POINTER(Z)];nv.nvrtcGetPTX.argtypes=[P,P]
    nv.nvrtcDestroyProgram.argtypes=[C.POINTER(P)]
    source=ROOT/'gpu-river-cfr.cu';prog=P();check(nv.nvrtcCreateProgram(C.byref(prog),source.read_bytes(),source.name.encode(),0,None,None))
    # Disabling FMA removes an avoidable arithmetic-order difference in strict
    # CPU/GPU audit fixtures; every strategic value and regret is still FP64.
    opts=(C.c_char_p*3)(b'--gpu-architecture=compute_89',b'--std=c++14',b'--fmad=false')
    result=nv.nvrtcCompileProgram(prog,3,opts);size=Z();nv.nvrtcGetProgramLogSize(prog,C.byref(size));buf=C.create_string_buffer(size.value);nv.nvrtcGetProgramLog(prog,buf)
    if result:raise RuntimeError(buf.value.decode())
    check(nv.nvrtcGetPTXSize(prog,C.byref(size)));buf=C.create_string_buffer(size.value);check(nv.nvrtcGetPTX(prog,buf));(ROOT/'gpu-river-cfr.ptx').write_bytes(buf.raw);nv.nvrtcDestroyProgram(C.byref(prog));return {'compiled':True,'ptxBytes':size.value}

class CFRGPU(GPU):
    def __init__(self):
        super().__init__();self.module=P();check(self.cuda.cuModuleLoad(C.byref(self.module),str(ROOT/'gpu-river-cfr.ptx').encode()));self.functions={};self.kernel_sha256=hashlib.sha256((ROOT/'gpu-river-cfr.ptx').read_bytes()).hexdigest()
        self.cuda.cuMemGetInfo_v2.argtypes=[C.POINTER(Z),C.POINTER(Z)]
    def empty(self,bytes_):
        ptr=D();check(self.cuda.cuMemAlloc_v2(C.byref(ptr),int(bytes_)));self.allocations.append(ptr);return ptr
    def launch_raw(self,name,blocks,args,threads=128):
        if name not in self.functions:
            fn=P();check(self.cuda.cuModuleGetFunction(C.byref(fn),self.module,name.encode()));self.functions[name]=fn
        params=(P*len(args))(*(C.cast(C.byref(x),P) for x in args))
        check(self.cuda.cuLaunchKernel(self.functions[name],blocks,1,1,threads,1,1,0,None,params,None))
    def read(self,ptr,shape,dtype=np.float64):
        a=np.empty(shape,dtype=dtype);check(self.cuda.cuMemcpyDtoH_v2(a.ctypes.data,ptr,a.nbytes));return a
    def solve(self,g,progress=True):
        started=time.perf_counter();N=len(g['players']);M=len(g['nodes']);deals=g['deals'];count=len(deals)
        if N not in (2,3):raise ValueError('Experimental GPU CFR currently supports 2–3 players')
        if not g.get('chance',{}).get('exact',False):raise ValueError('Experimental GPU CFR requires exact full chance')
        algorithm=g.get('algorithm','cfr-plus')
        if algorithm not in ('cfr-plus','dcfr','alternating-cfr-plus'):raise ValueError('Unsupported GPU CFR algorithm')
        actors=[];actions=[];offsets=[];edge_offsets=[];edges=[];parents=[-1]*M;parent_actions=[-1]*M;info_node=[];info_combo=[];cells=0
        for n,node in enumerate(g['nodes']):
            p=node['actor'];A=len(node['actions']);actors.append(p);actions.append(A);offsets.append(cells);edge_offsets.append(len(edges))
            if p>=0:
                if not 1<=A<=8:raise ValueError('Action count outside tested GPU bound')
                for c in range(len(g['combinations'][p])):info_node.append(n);info_combo.append(c)
                cells+=len(g['combinations'][p])*A
                for a,act in enumerate(node['actions']):
                    child=act['child'];edges.append(child)
                    if child<=n:raise ValueError('GPU reverse traversal requires strict preorder tree')
                    parents[child]=n;parent_actions[child]=a
        infosets=len(info_node);hands=np.array([d['hands'] for d in deals],dtype=np.int32).T.copy();ranks=np.array([d['ranks'] for d in deals],dtype=np.int32).T.copy();chance=np.array([d['weight'] for d in deals],dtype=np.float64)
        combo_offsets=[0]
        for rg in g['combinations']:combo_offsets.append(combo_offsets[-1]+len(rg))
        deal_indices=[];deal_offsets=[0]
        for p in range(N):
            for c in range(len(g['combinations'][p])):deal_indices.extend(np.flatnonzero(hands[p]==c).tolist());deal_offsets.append(len(deal_indices))
        required=M*N*count*8+cells*8*4+N*count*16+len(deal_indices)*4+M*N*12+infosets*16
        free=Z();total=Z();check(self.cuda.cuMemGetInfo_v2(C.byref(free),C.byref(total)))
        budget=int(g.get('gpuMemoryBytes',4_000_000_000))
        if required>min(budget,free.value*.7):raise ValueError(f'GPU exact workspace needs {required:,} bytes; free {free.value:,}, configured budget {budget:,}. Reduce the tree or ranges; no sampling fallback was used.')
        lock_policy=np.zeros(cells,dtype=np.float64);locked=np.zeros(infosets,dtype=np.int32);lookup={(n,c):i for i,(n,c) in enumerate(zip(info_node,info_combo))}
        for lock in g.get('locks',[]):
            n=lock['node'];A=actions[n];p=actors[n];cs=range(len(g['combinations'][p])) if lock['combo']<0 else [lock['combo']]
            for c in cs:locked[lookup[n,c]]=1;lock_policy[offsets[n]+c*A:offsets[n]+(c+1)*A]=lock['probabilities']
        to_i=lambda xs:self.alloc(np.asarray(xs,dtype=np.int32));to_f=lambda xs:self.alloc(np.asarray(xs,dtype=np.float64))
        da=to_i(actors);dA=to_i(actions);doff=to_i(offsets);deo=to_i(edge_offsets);de=to_i(edges);dp=to_i(parents);dpa=to_i(parent_actions);din=to_i(info_node);dic=to_i(info_combo);dh=self.alloc(hands);drank=self.alloc(ranks);dc=self.alloc(chance);dco=to_i(combo_offsets);ddo=to_i(deal_offsets);ddi=to_i(deal_indices)
        contrib=to_f([n['contributions'] for n in g['nodes']]);folded=to_i([n['folded'] for n in g['nodes']]);dlocked=self.alloc(locked);dlp=self.alloc(lock_policy)
        regrets=to_f(np.zeros(cells));average=to_f(np.zeros(cells));strategy=to_f(np.zeros(cells));values=self.empty(M*N*count*8)
        policy_args=[I(infosets),din,dic,dA,doff,regrets,average,dlocked,dlp,strategy]
        backwards=[I(count),I(N),I(M),da,dA,de,deo,doff,dh,strategy,values]
        fixed_rake=float(g.get('fixedRake',0))
        if not np.isfinite(fixed_rake) or fixed_rake<0 or fixed_rake>g['pot']:raise ValueError('Invalid constant capped rake')
        self.launch_raw('initialize_payoffs',(count+127)//128,[I(count),I(N),I(M),C.c_double(g['pot']-fixed_rake),da,contrib,folded,drank,values]);check(self.cuda.cuCtxSynchronize())
        preparation=time.perf_counter()-started;training_started=time.perf_counter();completed=0;timed_out=False;iterations=int(g['iterations']);delay=int(g['averagingDelay']);snapshots=[];capture=set(g.get('captureIterations',[]));max_seconds=float(g.get('maxSeconds',1200))
        control=g.get('_adaptive');adaptive=bool(control and control.get('enabled'));checkpoint_number=0;training_accumulated=0.;batch_started=training_started;wait_seconds=0.;checkpoint_seconds=0.
        next_check=min(iterations,max(delay+1,int(control['checkEvery']))) if adaptive else iterations

        def export_policy(training_seconds,stop_reason):
            # Read-only with respect to the persistent regrets and average.
            # The next iteration always rebuilds strategy from regrets first.
            self.launch_raw('policy',(infosets+127)//128,policy_args+[I(1)]);self.launch_raw('backward_values',(count+127)//128,backwards+[I(-1)]);check(self.cuda.cuCtxSynchronize())
            probabilities=self.read(strategy,cells);root_values=self.read(values,(N,count));profile=np.dot(root_values,chance).tolist()
            if np.any(~np.isfinite(probabilities)):raise ArithmeticError('GPU strategy contains nonfinite values')
            return {'schemaVersion':1,'engine':self.name+' experimental exact FP64 '+algorithm,'experimental':True,'iterations':completed,'stopReason':stop_reason,'algorithm':algorithm,'averagingDelay':delay,'precision':'float64','chanceExact':True,'legalDeals':count,'publicNodes':M,'infoSets':infosets,'strategyCells':cells,'allocatedEstimateBytes':required,'freeDeviceBytesAtStart':free.value,'preparationSeconds':preparation,'trainingSeconds':training_seconds,'verificationWaitSeconds':wait_seconds,'checkpointSeconds':checkpoint_seconds,'seconds':time.perf_counter()-started,'profileEV':profile,'policy':[{'node':n,'combo':c,'probabilities':probabilities[offsets[n]+c*actions[n]:offsets[n]+(c+1)*actions[n]].tolist()} for n,c in zip(info_node,info_combo)],'snapshots':snapshots,'qualityVerified':False,'kernelSHA256':self.kernel_sha256,'limits':['Experimental strategy implementation. Independent CPU information-set best response is required to verify the final policy.','Full exact legal chance enumeration; no Monte Carlo or hidden-card-dependent decision maximization.','GPU alone does not report a convergence certificate or claim a speedup.']}
        for iteration in range(1,iterations+1):
            for player in (range(N) if algorithm=='alternating-cfr-plus' else [-1]):
                self.launch_raw('policy',(infosets+127)//128,policy_args+[I(0)])
                self.launch_raw('backward_values',(count+127)//128,backwards+[I(player)])
                self.launch_raw('update_regrets',infosets,[I(count),I(N),I(infosets),I(iteration),I(delay),din,dic,da,dA,doff,de,deo,dp,dpa,dh,dco,ddo,ddi,dc,strategy,values,regrets,average,I(algorithm=='dcfr'),I(player),I(algorithm!='alternating-cfr-plus')])
            if algorithm=='alternating-cfr-plus':
                self.launch_raw('policy',(infosets+127)//128,policy_args+[I(0)])
                self.launch_raw('accumulate_average',(infosets+127)//128,[I(infosets),I(iteration),I(delay),din,dic,da,dA,doff,dp,dpa,strategy,average])
            completed=iteration
            if iteration in capture:
                check(self.cuda.cuCtxSynchronize());snapshots.append({'iteration':iteration,'regrets':self.read(regrets,cells).tolist(),'average':self.read(average,cells).tolist()})
            if iteration%25==0 or iteration==iterations or adaptive and iteration==next_check:
                check(self.cuda.cuCtxSynchronize());elapsed=training_accumulated+time.perf_counter()-batch_started if adaptive else time.perf_counter()-training_started
                if progress:print(json.dumps({'phase':'gpu-training','iteration':iteration,'seconds':elapsed,'device':self.name}),flush=True)
                if not adaptive and elapsed>=max_seconds:timed_out=True;break
            if adaptive and iteration==next_check:
                # Pause only after all alternating player passes and averaging.
                training_accumulated+=time.perf_counter()-batch_started;checkpoint_number+=1;export_started=time.perf_counter()
                result=export_policy(training_accumulated,'checkpoint');result.update({'checkpoint':checkpoint_number,'nonce':control['nonce'],'inputSHA256':g['_inputSHA256']})
                folder=pathlib.Path(control['directory']);folder.mkdir(parents=True,exist_ok=True);filename=f'checkpoint-{checkpoint_number}.json';output=folder/filename;temporary=folder/(filename+'.tmp')
                payload=json.dumps(result,allow_nan=False).encode('utf-8');temporary.write_bytes(payload);temporary.replace(output);digest=hashlib.sha256(payload).hexdigest();checkpoint_seconds+=time.perf_counter()-export_started
                print(json.dumps({'phase':'checkpoint-ready','checkpoint':checkpoint_number,'iteration':iteration,'file':filename,'sha256':digest,'nonce':control['nonce'],'inputSHA256':g['_inputSHA256']}),flush=True)
                waiting=time.perf_counter();line=sys.stdin.readline();wait_seconds+=time.perf_counter()-waiting
                if not line:raise RuntimeError('Adaptive controller disconnected; GPU state released without publishing unverified quality')
                command=json.loads(line)
                if command.get('nonce')!=control['nonce'] or command.get('checkpoint')!=checkpoint_number or command.get('sha256')!=digest:raise RuntimeError('Adaptive command does not match the current checkpoint')
                if command.get('command')=='stop':
                    reason=command.get('reason')
                    if reason not in ('accuracy_target','iteration_limit','time_limit'):raise RuntimeError('Invalid adaptive stop reason')
                    result.update({'stopReason':reason,'verificationWaitSeconds':wait_seconds,'checkpointSeconds':checkpoint_seconds,'seconds':time.perf_counter()-started});return result
                next_check=command.get('nextIteration')
                if command.get('command')!='continue' or type(next_check) is not int or not iteration<next_check<=iterations:raise RuntimeError('Invalid adaptive continuation iteration')
                batch_started=time.perf_counter()
        check(self.cuda.cuCtxSynchronize());training_seconds=time.perf_counter()-training_started
        return export_policy(training_seconds,'time_limit' if timed_out else 'iteration_limit')

if __name__=='__main__':
    try:
        if len(sys.argv)>1 and sys.argv[1]=='compile':print(json.dumps(compile_kernel(sys.argv[2])))
        else:
            input_bytes=pathlib.Path(sys.argv[1]).read_bytes();g=json.loads(input_bytes.decode('utf-8'));g['_inputSHA256']=hashlib.sha256(input_bytes).hexdigest();gpu=CFRGPU()
            try:result=gpu.solve(g)
            finally:gpu.close()
            pathlib.Path(sys.argv[2]).write_text(json.dumps(result),encoding='utf-8');print(json.dumps({'phase':'complete','iterations':result['iterations'],'trainingSeconds':result['trainingSeconds']}),flush=True)
    except Exception as e:print(json.dumps({'error':str(e)}),file=sys.stderr);sys.exit(1)
