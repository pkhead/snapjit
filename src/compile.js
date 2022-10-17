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

    // script environment/variables
    class Environment {
        constructor(parent) {
            this.parent = parent || null;

            this.variables = new Map();
            this.identifiers = new Set();
            this.sanitized = new Set();

            this.needsDefine = new Set();

            this.methods = new Set();
            this.doesYield = false;
            this.emptySlotId = -1;
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
            return this.sanitized.has(name) || (this.parent ? this.parent.hasSanitized(name) : false);
        }

        getVariable(name) {
            return this.variables.get(name) || (this.parent ? this.parent.getVariable(name) : null);
        }

        addVariable(name, input = false, upvar = false) {
            // if variable is already defined within env, return data of already defined variable
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

            if (!input) {
                this.needsDefine.add(name);
            }

            return varData;
        }

        addIdentifier(id, upvar) {
            this.sanitized.add(id);

            var varData = {
                id: id,
                upvar: upvar,

                define: () => varData.upvar ? `${varData.id}=[0]` : `${varData.id}=0`,
                set: (v) => varData.upvar ? `${varData.id}[0]=${v}` : `${varData.id}=${v}`,
                setOp: (op, v) => varData.upvar ? `${varData.id}[0]${op}${v}` : `${varData.id}${op}${v}`,
                get: () => varData.upvar ? `${varData.id}[0]` : varData.id
            };
            this.identifiers.set(id, varData);

            return varData;
        }

        getIdentifier(id) {
            return this.identifiers.get(id) || this.parent?.get(id) || null;
        }
    }

    // block environment
    class Scope {
        constructor(parent) {
            this.parent = parent;
            this.env = parent?.env || new Environment();
            this.upvarDefines = [];
        }

        inherit() {
            return new this.constructor(this);
        }

        /*
        defineUpvars() {
            if (this.upvarDefines.length === 0) return "";
            var res = "var " + this.upvarDefines.map(v => `${v}=[0]`).join(",") + ";\n";
            this.upvarDefines = [];
            return res;
        }

        addUpvarId(id) {
            if (this.parent) {
                this.parent.addUpvarId(id);
            } else {
                this.upvarDefines.push(id);
            }
        }*/
    }

    function readUpvarName(slot) {
        return slot.parts()[0].parts()[0].text;
    }

    const customDefinitions = new Map();

    function* EMPTY_DEF() {
    }

    function setCustomDef(spec, def) {
        var ctx = def.body;
        console.log("compile custom def", def);
        var compiled, types;

        var inputs = [];
        var types = [];

        for (let [key, value] of def.declarations) {
            inputs.push([value[0], key]);
            types.push(value[0]);
        }

        if (ctx) compiled = compile(ctx.expression, null, inputs);
        else compiled = EMPTY_DEF;

        var data = {compiled: compiled, types: types}
        customDefinitions.set(spec, data);
        return data;
    }

    function compileInput(scope, input) {
        if (input instanceof RingMorph) {
            let codeMorph = input.contents();

            let params = input.inputNames();
            let newScope = new Scope();
            newScope.env = new Environment(scope.env);

            let implicit = params == 0;
            let emptySlots = codeMorph.allEmptySlots();
            let paramIDs = [];

            if (implicit) {
                // add implicit parameters
                for (let i = 0; i < emptySlots.length; i++) {
                    newScope.env.emptySlotId = 0;
                    //paramIDs.push(newEnv.scope.addIdentifier("arg"+i).id);
                    paramIDs.push("PARAM" + i);
                }
            } else {
                // add explicit parameters to function
                for (let param of params) {
                    paramIDs.push(newScope.env.addVariable(param, true, false).id);
                }
            }

            let code = compileScript(newScope, codeMorph);

            //if (!(codeMorph instanceof RingCommandSlotMorph)) {
            //    code = "return " + code;
            //}

            console.log(params);
            console.log(codeMorph);

            if (!implicit) {
                // default every param but param1 to zero (need to check if it is undefined)
                return `function*(${paramIDs.map((v,i) => i>0 ? v+"=0" : v).join(",")}){\n` +
                // throw error if there are no inputs
                `if(${paramIDs[0]}===undefined)throw new ReferenceError("a variable of name '${params[0]}' does not exist in this context");\n` +
                `${code}\n}`;
            } else {
                // TODO weird implicit behavior with mismatched inputs
                return `function*(${paramIDs.map(v=>v+"=0").join(",")}){\n` +
                code +
                `\n}`;
            }

            //if (newEnv.doesYield) {
                return `function*(${paramIDs.join(",")}){\n${code}}`;
            //} else {
            //    return `(${paramIDs.join(",")})=>{\n${code}}`;
            //}
        } else if (input instanceof InputSlotMorph) {
            let text;

            if (input.constant) {
                text = input.constant[0];
            } else {
                dataMorph = input.parts()[0];
                text = input.parts()[0].text;
            }

            if (text.length === 0) {
                // if environment has implicit params
                if (scope.env.emptySlotId >= 0) {
                    return "PARAM" + (scope.env.emptySlotId++);
                } else {
                    return "\"\"";
                }
            } else {
                // if input is a number and input slot is numeric
                if (!Number.isNaN(+text)) {
                    return `${text}`;

                // as string
                } else {
                    return `"${text}"`;
                }
            }

        } else if (input instanceof TemplateSlotMorph) {
            return {type: "upvar", value: input.contents()};
        }
        
        else if (input instanceof BooleanSlotMorph) {
            return input.value ? input.value.toString() : "null";
        
        } else if (input instanceof MultiArgMorph) {
            let inputs = input.inputs();
            let args = inputs.map(v => compileInput(scope, v));
            return `new List([${args.join(",")}])`;
        
        // list as arguments
        } else if (input instanceof ArgLabelMorph) {
            return compileInput(scope, input.parts()[1]);
    
        } else if (input instanceof CSlotMorph) {
            scope.doesYield = true;
            return `function*(){\n${compileScript(scope.inherit(), input.nestedBlock())}\n}`;
            
        } else if (input instanceof BlockMorph) {
            return compileBlock(scope, input);
            
        // empty slot
        } else if (input instanceof ArgMorph) {
            if (scope.env.emptySlotId >= 0) {
                return "PARAM" + (scope.env.emptySlotId++);
            } else {
                return "null";
            }
        }
        console.log(input);
    }

    function compileBlock(scope, block) {
        switch (block.selector) {
            case "log": {
                let args = compileInput(scope, block.inputs()[0]);
                
                return `console.log("Snap!", ...(${args}.itemsArray()))`;
            }

            /* CONTROL */
            case "doReport": {
                return `return ${compileInput(scope, block.inputs()[0])}`;
            }

            case "doWait": {
                scope.doesYield = true;
                return `yield ["wait", ${block.inputs().map(v => compileInput(scope, v)).join(",")}]`;
            }

            case "doForever": {
                let inputs = block.inputs();

                scope.doesYield = true;
                return `while(true){\n${compileScript(scope.inherit(), inputs[0].nestedBlock())}\nyield;}`
            }

            case "doRepeat": {
                let inputs = block.inputs();
                let repeats = compileInput(scope, inputs[0]);

                scope.doesYield = true;
                return `{let end=+${repeats};for(let n=0;n<end;n++){\n${compileScript(scope.inherit(), inputs[1].nestedBlock())}\nyield;}}`;
            }

            case "doUntil": {
                let inputs = block.inputs();

                scope.doesYield = true;
                return `while(!(${compileInput(scope, inputs[0])})){\n${compileScript(scope.inherit(), inputs[1].nestedBlock())}\nyield;}`
            }

            case "doFor": {
                let inputs = block.inputs();

                let counterName = readUpvarName(inputs[0]);

                let varData = scope.env.getVariable(counterName);

                let out = "";
                if (!varData) {
                    varData = scope.env.addVariable(counterName);
                    out = `var ${varData.define()};`
                }

                let start = compileInput(scope, inputs[1]);
                let end = compileInput(scope, inputs[2]);
                let script = compileScript(scope.inherit(), inputs[3].nestedBlock());
                scope.env.doesYield = true;

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

                let condition = compileInput(scope, inputs[0]);
                let nested = compileScript(scope.inherit(), inputs[1].nestedBlock());

                return `if(${condition}){\n${nested}\n}`;
            }

            case "doIfElse": {
                let inputs = block.inputs();

                let condition = compileInput(scope, inputs[0]);
                let nested1 = compileScript(scope.inherit(), inputs[1].nestedBlock());
                let nested2 = compileScript(scope.inherit(), inputs[2].nestedBlock());

                return `if(${condition}){\n${nested1}\n}else{${nested2}}`;
            }

            case "reportIfElse": {
                let inputs = block.inputs();

                let condition = compileInput(scope, inputs[0]);
                let nested1 = compileScript(scope.inherit(), inputs[1].nestedBlock());
                let nested2 = compileScript(scope.inherit(), inputs[2].nestedBlock());

                return `(${condition})?(${nested1}):(${nested2}})`;
            }

            case "doRun": case "evaluate": {
                let inputs = block.inputs();
                
                let args = inputs[1].inputs().map(v => compileInput(scope, v));
                let code = compileInput(scope, inputs[0]);

                scope.env.doesYield = true;
                return `yield* (${code})(${args.join(",")})`;
            }

            case "fork": {
                let inputs = block.inputs();

                let args = inputs[1].inputs().map(v => compileInput(scope, v));
                let code = compileInput(scope, inputs[0]);

                let forkArgs = [code, ENV, ...args];
                return `ENV.func.fork(${forkArgs.join(",")})`;
            }

            /* OPERATORS */
            case "reportBoolean": {
                let input = block.inputs()[0];
                return input.value ? "true" : "false"
            }

            /* VARIABLES/LISTS */
            case "reportGetVar": {
                let varName = block.parts()[0].text;
                let varData = scope.env.getVariable(varName);

                if (varData) {
                    return varData.get();
                } else {
                    return `ENV.process.homeContext.variables.getVar("${varName}")`;
                }
            }
            case "reportNewList": {
                //return `new List(${ block.inputs().map(v => compileInput(scope, v)).join(",") })`;
                return compileInput(scope, block.inputs()[0]);
            }

            case "doDeclareVariables": {
                let defined = [];

                for (let slotMorph of block.inputs()[0].parts()) {
                    if (slotMorph instanceof TemplateSlotMorph) {
                        let name = slotMorph.contents();//readUpvarName(slotMorph);
                        defined.push(scope.env.addVariable(name));
                    }
                }

                //return `var ${defined.map(v => v.define()).join(",")}`;
                return null;
            }

            case "doSetVar": {
                let inputs = block.inputs();
                
                let varName = inputs[0].parts()[0].text;
                let value = compileInput(scope, inputs[1]);

                let varData = scope.env.getVariable(varName);
                if (!varData) { // TODO if not defined, try setting a global value instead of throwing an error
                    //throw [new ReferenceError(`${varName} is not defined`), block];
                    return `ENV.process.homeContext.variables.setVar("${varName}", ${value})`;
                }

                return varData.set(value);
            }

            case "doChangeVar": {
                let inputs = block.inputs();

                let varName = inputs[0].parts()[0].text;
                let value = compileInput(scope, inputs[1]);

                let varData = scope.env.getVariable(varName);
                if (!varData) { // TODO try setting global value instead of throwing an error
                    throw [new ReferenceError(`${varName} is not defined`), block];
                }

                return varData.setOp("+=", value);
            }

            case "evaluateCustomBlock": {
                let inputs = block.inputs();
                //let argsArr = inputs.map(v => compileInput(scope, v));
                let args = [];

                // upvars will be declared in the lines before the command where the upvar appears
                // upvar declaration will be deferred to the compileScript function, where it will
                // insert a declaration before the final emitted line
                for (let input of inputs) {
                    let compiled = compileInput(scope, input);

                    // if non-primitive type
                    if (typeof compiled === "object") {
                        if (compiled.type === "upvar") {
                            let id = scope.env.addVariable(compiled.value, false, true).id
                            //scope.addUpvarId(id);
                            args.push(id);
                        }
                    } else {
                        args.push(compiled);
                    }

                }
                
                if (block.isGlobal) {
                    let blockData = customDefinitions.get(block.semanticSpec);

                    if (!blockData) {
                        blockData = setCustomDef(block.semanticSpec, block.definition);
                    }

                    // TODO unevaluated inputs
                } else {
                    scope.env.methods.add(block.semanticSpec);
                }

                args.unshift("ENV.process", "{receiver:ENV.sprite}");
                
                scope.doesYield = true;
                return `yield* ENV.${block.isGlobal ? "custom" : "method"}.get("${block.semanticSpec}").compiled(${args.join(",")})`;
            }

            default: {
                let inputs = block.inputs();
                let args = inputs.map(v => compileInput(scope, v)).join(",");

                if (block.selector in yieldingOverrides) {
                    doesYield = true;
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

    function compileScript(scope, script) {
        if (!script) return "";

        var output;

        /*if (script instanceof HatBlockMorph) {
            switch (script.selector) {
                case "receiveGo": {
                    output = `onGo(function*() {\n${compileScript(scope, script.nextBlock())}\n})`;
                    break;
                }

                default: {
                    throw new Error(`unknown event selector ${script.selector}`);
                }
            }
        } else {*/
        const varDefs = env => "var " + Array.from(env.needsDefine.values()).map(v=>env.getVariable(v).define()).join(",") + ";";

        if (script instanceof ReporterBlockMorph) {
            let compiled = compileBlock(scope, script);

            // if on top-most scope, define script variables
            if (!scope.parent && scope.env.needsDefine.size > 0) {
                output = varDefs(scope.env) +`\nreturn ${compiled};`;
            } else {
                output = `return ${compiled};`;
            }
        } else {
            let out = [];

            for (let block of script.blockSequence()) {
                let compiled = compileBlock(scope, block);
                //out.push(scope.defineUpvars() + compiled +";");
                if (compiled) out.push(compiled+";");

                // stop compiling if it is a hat block morph
                // hat block morphs compile the rest of the script
                if (block instanceof HatBlockMorph) break;
            }

            // if on top-most scope, define script variables
            if (!scope.parent) {
                if (scope.env.needsDefine.size > 0) {
                    out.unshift(varDefs(scope.env));
                }
            }

            output = out.join("\n");
        }

        return output;
    }

    /*compile(sprite) {
        var compiled = [];
        var scope = {};
        var scriptEnv = {}

        for (let script of sprite.scripts.children) {
            let code = compileScript(scope, script);
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

            var scope = new Scope();

            /*
            var env = {};
            env.scope = new Scope(null);
            env.methods = new Set();
            env.doesYield = false;
            env.emptySlotId = -1;
            env.newScope = function() {
                return {
                    doesYield: false,
                    scope: new Scope(env.scope),
                    customBlocks: env.customBlocks,
                    emptySlotId: -1,
                };
            };
            */
            
            // add inputs to scope
            var inputIds = [];

            // possible formats:
            // [[inputType, inputName]...]
            if (Array.isArray(inputs[0])) {
                for (let [inputType, inputName] of inputs) {
                    if (inputType === "%upvar") {
                        inputIds.push(scope.env.addVariable(inputName, true, true).id);
                    } else {
                        inputIds.push(scope.env.addVariable(inputName, true, false).id);
                    }
                    // TODO unevaluated inputs
                }

            // [inputName...]
            } else {
                for (let inputName of inputs) {
                    inputIds.push(scope.env.addVariable(inputName, true, false).id);
                }
            }

            var scriptEnv = {func: functions, methods: {}};
            var code;

            if (topBlock instanceof RingMorph) {
                code = `return ${compileInput(scope, topBlock)};`
            } else {
                code = compileScript(scope, topBlock);
            }

            console.log("Compilation result");
            console.log(code);

            // get custom blocks used in script
            var methodMap = new Map();

            for (let block of scope.env.methods) {
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