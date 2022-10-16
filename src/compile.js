/*
    compile.js

    main script for jit compilation
    written by pkhead

*/

(function() {
    function escapeString(str) {
        return str.replaceAll("\"", "\\\"").replaceAll("\n", "\\\n").replaceAll("\t", "\\\t");
    }

    const GeneratorFunction = (function*(){}).constructor;

    const yieldingOverrides = {
        *doWarp(ENV, code) {
            ENV.process.isAtomic = true;
            if (!ENV.process._warpLevel) {
                ENV.process._warpLevel = 0;
            }
            ENV.process._warpLevel++;
            yield* code();
            ENV.process._warpLevel--;
            ENV.process.isAtomic = ENV.process._warpLevel > 0;
        },

        *doSayFor(ENV, data, waitTime) {
            ENV.process.blockReceiver().bubble(data);
            yield ["wait", +waitTime];
            ENV.process.blockReceiver().stopTalking();
        },

        *customBlock(ENV, semanticSpec, ...args) {
            let method = ENV.process.blockReceiver().getMethod(semanticSpec);
            console.log(method);
            return 0;
        },
    }

    const overrides = {
        reportNewList(ENV, ...elements) {
            return new List(elements);
        },
    }

    class Scope {
        constructor(parentScope) {
            this.parentScope = parentScope || null;

            this.variables = new Map();
            this.sanitized = new Set();
        }

        sanitizeName(name) {
            var i = 0;

            // replace invalid characters with underscores
            var vName = name.replaceAll(/\W/g, "_");

            if (!this.variables.has(name)) {
                // prevent name collision from symbols converting into underscores
                while (this.hasSanitized(`_${i>0?i:""}` + vName)) {
                    i++;
                }
            }

            return `_${i>0?i:""}` + vName;
        }

        hasSanitized(name) {
            return this.sanitized.has(name) || (this.parentScope ? this.parentScope.hasSanitized(name) : false);
        }

        getVariable(name) {
            return this.variables.get(name) || (this.parentScope ? this.parentScope.getVariable(name) : null);
        }

        addVariable(name, upvar = false) {
            // if variable is already defined within scope, return data of already defined variable
            // and set upvar of vardata as well
            var varData = this.variables.get(name);
            if (varData) {
                varData.upvar = upvar;
                return varData;
            }

            var sanit = this.sanitizeName(name);
            this.sanitized.add(sanit);

            varData = {
                id: sanit,
                upvar: upvar,

                define: () => varData.upvar ? `${varData.id}=[0]` : `${varData.id}=0`,
                set: (v) => varData.upvar ? `${varData.id}[0]=${v}` : `${varData.id}=${v}`,
                setOp: (op, v) => varData.upvar ? `${varData.id}[0]${op}${v}` : `${varData.id}${op}${v}`,
                get: () => varData.upvar ? `${varData.id}[0]` : varData.id
            };
            this.variables.set(name, varData);

            return varData;
        }
    }

    function readUpvarName(slot) {
        return slot.parts()[0].parts()[0].text;
    }

    const customDefinitions = new Map();

    function setCustomDef(spec, def) {
        var ctx = def.body;
        console.log("compile custom def");
        var compiled = compile(ctx.expression, null, ctx.inputs);

        customDefinitions.set(spec, compiled);
    }

    function compileInput(env, input) {
        if (input instanceof RingMorph) {
            let inputs = input.inputs();

            let codeMorph = inputs[0];

            let params = input.inputNames();
            let newEnv = env.newScope(params);

            let code = compileScript(newEnv, codeMorph.parts()[0]);

            //if (!(codeMorph instanceof RingCommandSlotMorph)) {
            //    code = "return " + code;
            //}

            console.log(params);
            console.log(codeMorph);

            return `function*(${params.join(",")}){\n${code}}`;

        } else if (input instanceof InputSlotMorph) {
            let text;

            if (input.constant) {
                text = input.constant[0];
            } else {
                dataMorph = input.parts()[0];
                text = input.parts()[0].text;
            }

            // if input is a number and input slot is numeric
            if (!Number.isNaN(+text)) {
                return `${text}`;

            // as string
            } else {
                return `"${text}"`;
            }

        } else if (input instanceof BooleanSlotMorph) {
            return input.value ? input.value.toString() : "null";
        
        } else if (input instanceof MultiArgMorph) {
            let inputs = input.inputs();
            let args = inputs.map(v => compileInput(env, v));
            return args.join(",");
        
        // list as arguments
        } else if (input instanceof ArgLabelMorph) {
            return compileInput(env, input.parts()[1]);
    
        } else if (input instanceof CSlotMorph) {
            return `function*(){yield;\n${compileScript(env, input.nestedBlock())}\n}`;
            
        } else if (input instanceof BlockMorph) {
            return compileBlock(env, input);
            
        // empty slot
        } else if (input instanceof ArgMorph) {
            return "null";
        }
        console.log(input);
    }

    function compileBlock(env, block) {
        switch (block.selector) {
            case "log": {
                let args = block.inputs().map(v => compileInput(env, v)).join(",");
                args.unshift("Snap!");

                return `console.log(${args})`;
            }

            /* CONTROL */
            case "doReport": {
                return `return ${compileInput(env, block.inputs()[0])}`;
            }

            case "doWait": {
                return `yield ["wait", ${block.inputs().map(v => compileInput(env, v)).join(",")}]`;
            }

            case "doForever": {
                let inputs = block.inputs();

                return `while(true){\n${compileScript(env, inputs[0].nestedBlock())}\nyield;}`
            }

            case "doRepeat": {
                let inputs = block.inputs();
                let repeats = compileInput(env, inputs[0]);

                return `for(let n=0;n<+${repeats};n++){\n${compileScript(env, inputs[1].nestedBlock())}\nyield;}`;
            }

            case "doUntil": {
                let inputs = block.inputs();

                return `while(!(${compileInput(env, inputs[0])})){\n${compileScript(env, inputs[1].nestedBlock())}\nyield;}`
            }

            case "doFor": {
                let inputs = block.inputs();

                let counterName = readUpvarName(inputs[0]);

                let varData = env.scope.getVariable(counterName);

                let out = "";
                if (!varData) {
                    varData = env.scope.addVariable(counterName);
                    out = `var ${varData.define()};`
                }

                let start = compileInput(env, inputs[1]);
                let end = compileInput(env, inputs[2]);
                let script = compileScript(env, inputs[3].nestedBlock());
                
                // this is extra complicated since it is calculating the direction of the for loop
                return out + `{let start=${start},end=${end};` +
                `for(${varData.set("start")};`+
                `end>start?${varData.get()}<=end:${varData.get()}>=start;`+
                `${varData.get()}+=end>start?1:-1){\n`+
                script+
                `\nyield;}}`;
            }

            case "doIf": {
                let inputs = block.inputs();

                let condition = compileInput(env, inputs[0]);
                let nested = compileScript(env, inputs[1].nestedBlock());

                return `if(${condition}){\n${nested}\n}`;
            }

            case "doIfElse": {
                let inputs = block.inputs();

                let condition = compileInput(env, inputs[0]);
                let nested1 = compileScript(env, inputs[1].nestedBlock());
                let nested2 = compileScript(env, inputs[2].nestedBlock());

                return `if(${condition}){\n${nested1}\n}else{${nested2}}`;
            }

            case "reportIfElse": {
                let inputs = block.inputs();

                let condition = compileInput(env, inputs[0]);
                let nested1 = compileScript(env, inputs[1].nestedBlock());
                let nested2 = compileScript(env, inputs[2].nestedBlock());

                return `(${condition})?(${nested1}):(${nested2}})`;
            }

            case "doRun": case "evaluate": {
                let inputs = block.inputs();
                
                let args = inputs[1].inputs().map(v => compileInput(env, v));
                let code = compileInput(env, inputs[0]);

                return `yield* (${code})(${args.join(",")})`;
            }

            case "fork": {
                let inputs = block.inputs();

                let args = inputs[1].inputs().map(v => compileInput(env, v));
                let code = compileInput(env, inputs[0]);

                let forkArgs = [code, ENV, ...args];
                return `ENV.func.fork(${forkArgs.join(",")})`;
            }

            /* VARIABLES/LISTS */
            case "reportGetVar": {
                let varName = block.parts()[0].text;
                let varData = env.scope.getVariable(varName);

                if (varData) {
                    return varData.get();
                } else {
                    return `ENV.process.homeContext.variables.getVar("${varName}")`;
                }
            }
            case "reportNewList": {
                return `new List([${ block.inputs().map(v => compileInput(env, v)).join(",") }])`;
            }

            case "doDeclareVariables": {
                let defined = [];

                for (let slotMorph of block.inputs()[0].parts()) {
                    if (slotMorph instanceof TemplateSlotMorph) {
                        let name = readUpvarName(slotMorph);
                        defined.push(env.scope.addVariable(name));
                    }
                }

                return `let ${defined.map(v => v.define()).join(",")}`;
            }

            case "doSetVar": {
                let inputs = block.inputs();
                
                let varName = inputs[0].parts()[0].text;
                let value = compileInput(env, inputs[1]);

                let varData = env.scope.getVariable(varName);
                if (!varData) { // TODO if not defined, try setting a global value instead of throwing an error
                    //throw [new ReferenceError(`${varName} is not defined`), block];
                    return `ENV.process.homeContext.variables.setVar("${varName}", ${value})`;
                }

                return varData.set(value);
            }

            case "doChangeVar": {
                let inputs = block.inputs();

                let varName = inputs[0].parts()[0].text;
                let value = compileInput(env, inputs[1]);

                let varData = env.scope.getVariable(varName);
                if (!varData) { // TODO try setting global value instead of throwing an error
                    throw [new ReferenceError(`${varName} is not defined`), block];
                }

                return varData.setOp("+=", value);
            }

            case "evaluateCustomBlock": {
                let inputs = block.inputs();
                let argsArr = inputs.map(v => compileInput(env, v));
                argsArr.unshift("ENV.process", "{receiver:ENV.sprite}");

                if (block.isGlobal) {
                    if (!customDefinitions.has(block.semanticSpec)) {
                        setCustomDef(block.semanticSpec, block.definition);;
                    }
                } else {
                    env.methods.add(block.semanticSpec);
                }
                
                return `yield* ENV.${block.isGlobal ? "custom" : "method"}.get("${block.semanticSpec}")(${argsArr.join(",")})`;
            }

            default: {
                let inputs = block.inputs();
                let args = inputs.map(v => compileInput(env, v)).join(",");

                if (block.selector in yieldingOverrides) {
                    return `yield* ENV.func.${block.selector}(ENV, ${args})`;
                } else if (block.selector in overrides) {
                    return `ENV.func.${block.selector}(ENV, ${args})`;
                } else if (block.selector in Process.prototype) {
                    return `ENV.process.${block.selector}(${args})`; 
                } else if (block.selector in SpriteMorph.prototype) {
                    return `ENV.sprite.${block.selector}(${args})`;
                } else {
                    throw [new Error(`Unknown selector "${block.selector}"`), block];
                }
            }
        }
    }

    function compileScript(env, script) {
        if (!script) return "";

        var output;

        /*if (script instanceof HatBlockMorph) {
            switch (script.selector) {
                case "receiveGo": {
                    output = `onGo(function*() {\n${compileScript(env, script.nextBlock())}\n})`;
                    break;
                }

                default: {
                    throw new Error(`unknown event selector ${script.selector}`);
                }
            }
        } else {*/
        if (script instanceof ReporterBlockMorph) {
            output = `return ${compileBlock(env, script)};`;
        } else {
            let out = [];

            for (let block of script.blockSequence()) {
                out.push(compileBlock(env, block)+";");

                // stop compiling if it is a hat block morph
                // hat block morphs compile the rest of the script
                if (block instanceof HatBlockMorph) break;
            }

            output = out.join("\n");
        }

        return output;
    }

    /*compile(sprite) {
        var compiled = [];
        var env = {};
        var scriptEnv = {}

        for (let script of sprite.scripts.children) {
            let code = compileScript(env, script);
            let func = new GeneratorFunction(code);
            compiled.push(code);
        }

        console.log(compiled);
        return compiled;
    }*/
    function compile(topBlock, receiver, inputs) {
        if (topBlock.compiled) {
            console.log("use cache", topBlock);
            return topBlock.compiled;
        } else {
            // copy overrides to a singular object
            var functions = {};

            for (let i in overrides) {
                functions[i] = overrides[i];
            }

            for (let i in yieldingOverrides) {
                functions[i] = yieldingOverrides[i];
            }

            var env = {};
            env.scope = new Scope(null);
            env.methods = new Set();
            env.newScope = function() {
                return {
                    scope: new Scope(env.scope),
                    customBlocks: env.customBlocks,
                };
            };
            
            // add inputs to scope
            var inputIds = [];
            for (let inputName of inputs) {
                inputIds.push(env.scope.addVariable(inputName).id);
            }

            var scriptEnv = {func: functions, methods: {}};
            var code;

            if (topBlock instanceof RingMorph) {
                code = `return ${compileInput(env, topBlock)};`
            } else {
                code = compileScript(env, topBlock);
            }

            console.log("Compilation result");
            console.log(code);

            // get custom blocks used in script
            var methodMap = new Map();

            for (let block of env.methods) {
                let method = receiver.getMethod(block.semanticSpec);
                console.log(method);

                methodMap.set(block.semanticSpec, method);
            }

            var func = GeneratorFunction("ENV", ...inputIds, code)
            var funcExport = (process, data = {}, ...params) => {
                return func({
                    process: process,
                    sprite: receiver || data.receiver,
                    func: scriptEnv.func,
                    custom: customDefinitions,
                    methods: methodMap,
                    warpLevel: data.warped ? 1 : 0,
                }, ...params);
            }

            console.log("set cache", topBlock);
            
            topBlock.compiled = funcExport;
            return funcExport;
        }
    }

    window.Compiler = {
        compile: compile,
        setCustomDef: setCustomDef,
    };
})();