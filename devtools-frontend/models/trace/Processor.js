// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
import * as Handlers from './handlers/handlers.js';
import * as Helpers from './helpers/helpers.js';
import * as Insights from './insights/insights.js';
import * as Lantern from './lantern/lantern.js';
import * as LanternComputationData from './LanternComputationData.js';
import * as Types from './types/types.js';
export class TraceParseProgressEvent extends Event {
    data;
    static eventName = 'traceparseprogress';
    constructor(data, init = { bubbles: true }) {
        super(TraceParseProgressEvent.eventName, init);
        this.data = data;
    }
}
function calculateProgress(value, phase) {
    // Finalize values should be [0.2...0.8]
    if (phase === 0.8 /* ProgressPhase.FINALIZE */) {
        return (value * (0.8 /* ProgressPhase.FINALIZE */ - 0.2 /* ProgressPhase.HANDLE_EVENT */)) + 0.2 /* ProgressPhase.HANDLE_EVENT */;
    }
    return value * phase;
}
export class TraceProcessor extends EventTarget {
    // We force the Meta handler to be enabled, so the TraceHandlers type here is
    // the model handlers the user passes in and the Meta handler.
    #traceHandlers;
    #status = "IDLE" /* Status.IDLE */;
    #modelConfiguration = Types.Configuration.defaults();
    #data = null;
    #insights = null;
    static createWithAllHandlers() {
        return new TraceProcessor(Handlers.ModelHandlers, Types.Configuration.defaults());
    }
    /**
     * This function is kept for testing with `stub`.
     */
    static getInsightRunners() {
        return { ...Insights.Models };
    }
    constructor(traceHandlers, modelConfiguration) {
        super();
        this.#verifyHandlers(traceHandlers);
        this.#traceHandlers = {
            Meta: Handlers.ModelHandlers.Meta,
            ...traceHandlers,
        };
        if (modelConfiguration) {
            this.#modelConfiguration = modelConfiguration;
        }
        this.#passConfigToHandlers();
    }
    #passConfigToHandlers() {
        for (const handler of Object.values(this.#traceHandlers)) {
            // Bit of an odd double check, but without this TypeScript refuses to let
            // you call the function as it thinks it might be undefined.
            if ('handleUserConfig' in handler && handler.handleUserConfig) {
                handler.handleUserConfig(this.#modelConfiguration);
            }
        }
    }
    /**
     * When the user passes in a set of handlers, we want to ensure that we have all
     * the required handlers. Handlers can depend on other handlers, so if the user
     * passes in FooHandler which depends on BarHandler, they must also pass in
     * BarHandler too. This method verifies that all dependencies are met, and
     * throws if not.
     **/
    #verifyHandlers(providedHandlers) {
        // Tiny optimisation: if the amount of provided handlers matches the amount
        // of handlers in the Handlers.ModelHandlers object, that means that the
        // user has passed in every handler we have. So therefore they cannot have
        // missed any, and there is no need to iterate through the handlers and
        // check the dependencies.
        if (Object.keys(providedHandlers).length === Object.keys(Handlers.ModelHandlers).length) {
            return;
        }
        const requiredHandlerKeys = new Set();
        for (const [handlerName, handler] of Object.entries(providedHandlers)) {
            requiredHandlerKeys.add(handlerName);
            const deps = 'deps' in handler ? handler.deps() : [];
            for (const depName of deps) {
                requiredHandlerKeys.add(depName);
            }
        }
        const providedHandlerKeys = new Set(Object.keys(providedHandlers));
        // We always force the Meta handler to be enabled when creating the
        // Processor, so if it is missing from the set the user gave us that is OK,
        // as we will have enabled it anyway.
        requiredHandlerKeys.delete('Meta');
        for (const requiredKey of requiredHandlerKeys) {
            if (!providedHandlerKeys.has(requiredKey)) {
                throw new Error(`Required handler ${requiredKey} not provided.`);
            }
        }
    }
    reset() {
        if (this.#status === "PARSING" /* Status.PARSING */) {
            throw new Error('Trace processor can\'t reset while parsing.');
        }
        const handlers = Object.values(this.#traceHandlers);
        for (const handler of handlers) {
            handler.reset();
        }
        this.#data = null;
        this.#insights = null;
        this.#status = "IDLE" /* Status.IDLE */;
    }
    async parse(traceEvents, options) {
        if (this.#status !== "IDLE" /* Status.IDLE */) {
            throw new Error(`Trace processor can't start parsing when not idle. Current state: ${this.#status}`);
        }
        try {
            this.#status = "PARSING" /* Status.PARSING */;
            await this.#computeParsedTrace(traceEvents, options);
            if (this.#data && !options.isCPUProfile) { // We do not calculate insights for CPU Profiles.
                this.#computeInsights(this.#data, traceEvents, options);
            }
            this.#status = "FINISHED_PARSING" /* Status.FINISHED_PARSING */;
        }
        catch (e) {
            this.#status = "ERRORED_WHILE_PARSING" /* Status.ERRORED_WHILE_PARSING */;
            throw e;
        }
    }
    /**
     * Run all the handlers and set the result to `#data`.
     */
    async #computeParsedTrace(traceEvents, options) {
        /**
         * We want to yield regularly to maintain responsiveness. If we yield too often, we're wasting idle time.
         * We could do this by checking `performance.now()` regularly, but it's an expensive call in such a hot loop.
         * `eventsPerChunk` is an approximated proxy metric.
         * But how big a chunk? We're aiming for long tasks that are no smaller than 100ms and not bigger than 200ms.
         * It's CPU dependent, so it should be calibrated on oldish hardware.
         * Illustration of a previous change to `eventsPerChunk`: https://imgur.com/wzp8BnR
         */
        const eventsPerChunk = 50_000;
        // Convert to array so that we are able to iterate all handlers multiple times.
        const sortedHandlers = [...sortHandlers(this.#traceHandlers).values()];
        // Reset.
        for (const handler of sortedHandlers) {
            handler.reset();
        }
        // Handle each event.
        for (let i = 0; i < traceEvents.length; ++i) {
            // Every so often we take a break just to render.
            if (i % eventsPerChunk === 0 && i) {
                // Take the opportunity to provide status update events.
                const percent = calculateProgress(i / traceEvents.length, 0.2 /* ProgressPhase.HANDLE_EVENT */);
                this.dispatchEvent(new TraceParseProgressEvent({ percent }));
                // TODO(paulirish): consider using `scheduler.yield()` or `scheduler.postTask(() => {}, {priority: 'user-blocking'})`
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            const event = traceEvents[i];
            for (let j = 0; j < sortedHandlers.length; ++j) {
                sortedHandlers[j].handleEvent(event);
            }
        }
        // Finalize.
        for (const [i, handler] of sortedHandlers.entries()) {
            if (handler.finalize) {
                // Yield to the UI because finalize() calls can be expensive
                // TODO(jacktfranklin): consider using `scheduler.yield()` or `scheduler.postTask(() => {}, {priority: 'user-blocking'})`
                await new Promise(resolve => setTimeout(resolve, 0));
                await handler.finalize(options);
            }
            const percent = calculateProgress(i / sortedHandlers.length, 0.8 /* ProgressPhase.FINALIZE */);
            this.dispatchEvent(new TraceParseProgressEvent({ percent }));
        }
        // Handlers that depend on other handlers do so via .data(), which used to always
        // return a shallow clone of its internal data structures. However, that pattern
        // easily results in egregious amounts of allocation. Now .data() does not do any
        // cloning, and it happens here instead so that users of the trace processor may
        // still assume that the parsed data is theirs.
        // See: crbug/41484172
        const shallowClone = (value, recurse = true) => {
            if (value instanceof Map) {
                return new Map(value);
            }
            if (value instanceof Set) {
                return new Set(value);
            }
            if (Array.isArray(value)) {
                return [...value];
            }
            if (typeof value === 'object' && value && recurse) {
                const obj = {};
                for (const [key, v] of Object.entries(value)) {
                    obj[key] = shallowClone(v, false);
                }
                return obj;
            }
            return value;
        };
        const parsedTrace = {};
        for (const [name, handler] of Object.entries(this.#traceHandlers)) {
            const data = shallowClone(handler.data());
            Object.assign(parsedTrace, { [name]: data });
        }
        this.dispatchEvent(new TraceParseProgressEvent({ percent: 1 /* ProgressPhase.CLONE */ }));
        this.#data = parsedTrace;
    }
    get parsedTrace() {
        if (this.#status !== "FINISHED_PARSING" /* Status.FINISHED_PARSING */) {
            return null;
        }
        return this.#data;
    }
    get insights() {
        if (this.#status !== "FINISHED_PARSING" /* Status.FINISHED_PARSING */) {
            return null;
        }
        return this.#insights;
    }
    #createLanternContext(parsedTrace, traceEvents, frameId, navigationId) {
        // Check for required handlers.
        if (!parsedTrace.NetworkRequests || !parsedTrace.Workers || !parsedTrace.PageLoadMetrics) {
            return;
        }
        if (!parsedTrace.NetworkRequests.byTime.length) {
            throw new Lantern.Core.LanternError('No network requests found in trace');
        }
        const navStarts = parsedTrace.Meta.navigationsByFrameId.get(frameId);
        const navStartIndex = navStarts?.findIndex(n => n.args.data?.navigationId === navigationId);
        if (!navStarts || navStartIndex === undefined || navStartIndex === -1) {
            throw new Lantern.Core.LanternError('Could not find navigation start');
        }
        const startTime = navStarts[navStartIndex].ts;
        const endTime = navStartIndex + 1 < navStarts.length ? navStarts[navStartIndex + 1].ts : Number.POSITIVE_INFINITY;
        const boundedTraceEvents = traceEvents.filter(e => e.ts >= startTime && e.ts < endTime);
        // Lantern.Types.TraceEvent and Types.Events.Event represent the same
        // object - a trace event - but one is more flexible than the other. It should be safe to cast between them.
        const trace = {
            traceEvents: boundedTraceEvents,
        };
        const requests = LanternComputationData.createNetworkRequests(trace, parsedTrace, startTime, endTime);
        const graph = LanternComputationData.createGraph(requests, trace, parsedTrace);
        const processedNavigation = LanternComputationData.createProcessedNavigation(parsedTrace, frameId, navigationId);
        const networkAnalysis = Lantern.Core.NetworkAnalyzer.analyze(requests);
        if (!networkAnalysis) {
            return;
        }
        const simulator = Lantern.Simulation.Simulator.createSimulator({
            // TODO(crbug.com/372674229): if devtools throttling was on, does this network analysis capture
            // that? Do we need to set 'devtools' throttlingMethod?
            networkAnalysis,
            throttlingMethod: 'provided',
        });
        const computeData = { graph, simulator, processedNavigation };
        const fcpResult = Lantern.Metrics.FirstContentfulPaint.compute(computeData);
        const lcpResult = Lantern.Metrics.LargestContentfulPaint.compute(computeData, { fcpResult });
        const interactiveResult = Lantern.Metrics.Interactive.compute(computeData, { lcpResult });
        const tbtResult = Lantern.Metrics.TotalBlockingTime.compute(computeData, { fcpResult, interactiveResult });
        const metrics = {
            firstContentfulPaint: fcpResult,
            interactive: interactiveResult,
            largestContentfulPaint: lcpResult,
            totalBlockingTime: tbtResult,
        };
        return { graph, simulator, metrics };
    }
    /**
     * Sort the insight models based on the impact of each insight's estimated savings, additionally weighted by the
     * worst metrics according to field data (if present).
     */
    sortInsightSet(insights, insightSet, metadata) {
        // The initial order of the insights is alphabetical, based on `front_end/models/trace/insights/Models.ts`.
        // The order here provides a baseline that groups insights in a more logical way.
        const baselineOrder = {
            InteractionToNextPaint: null,
            LCPPhases: null,
            LCPDiscovery: null,
            CLSCulprits: null,
            RenderBlocking: null,
            NetworkDependencyTree: null,
            ImageDelivery: null,
            DocumentLatency: null,
            FontDisplay: null,
            Viewport: null,
            DOMSize: null,
            ThirdParties: null,
            DuplicateJavaScript: null,
            SlowCSSSelector: null,
            ForcedReflow: null,
        };
        // Determine the weights for each metric based on field data, utilizing the same scoring curve that Lighthouse uses.
        const weights = Insights.Common.calculateMetricWeightsForSorting(insightSet, metadata);
        // Normalize the estimated savings to a single number, weighted by its relative impact
        // to the page experience based on the same scoring curve that Lighthouse uses.
        const observedLcp = Insights.Common.getLCP(insights, insightSet.id)?.value;
        const observedCls = Insights.Common.getCLS(insights, insightSet.id).value;
        // INP is special - if users did not interact with the page, we'll have no INP, but we should still
        // be able to prioritize insights based on this metric. When we observe no interaction, instead use
        // a default value for the baseline INP.
        const observedInp = Insights.Common.getINP(insights, insightSet.id)?.value ?? 200;
        const observedLcpScore = observedLcp !== undefined ? Insights.Common.evaluateLCPMetricScore(observedLcp) : undefined;
        const observedInpScore = Insights.Common.evaluateINPMetricScore(observedInp);
        const observedClsScore = Insights.Common.evaluateCLSMetricScore(observedCls);
        const insightToSortingRank = new Map();
        for (const [name, model] of Object.entries(insightSet.model)) {
            const lcp = model.metricSavings?.LCP ?? 0;
            const inp = model.metricSavings?.INP ?? 0;
            const cls = model.metricSavings?.CLS ?? 0;
            const lcpPostSavings = observedLcp !== undefined ? Math.max(0, observedLcp - lcp) : undefined;
            const inpPostSavings = Math.max(0, observedInp - inp);
            const clsPostSavings = Math.max(0, observedCls - cls);
            let score = 0;
            if (weights.lcp && lcp && observedLcpScore !== undefined && lcpPostSavings !== undefined) {
                score += weights.lcp * (Insights.Common.evaluateLCPMetricScore(lcpPostSavings) - observedLcpScore);
            }
            if (weights.inp && inp && observedInpScore !== undefined) {
                score += weights.inp * (Insights.Common.evaluateINPMetricScore(inpPostSavings) - observedInpScore);
            }
            if (weights.cls && cls && observedClsScore !== undefined) {
                score += weights.cls * (Insights.Common.evaluateCLSMetricScore(clsPostSavings) - observedClsScore);
            }
            insightToSortingRank.set(name, score);
        }
        // Now perform the actual sorting.
        const baselineOrderKeys = Object.keys(baselineOrder);
        const orderedKeys = Object.keys(insightSet.model);
        orderedKeys.sort((a, b) => {
            const a1 = baselineOrderKeys.indexOf(a);
            const b1 = baselineOrderKeys.indexOf(b);
            if (a1 >= 0 && b1 >= 0) {
                return a1 - b1;
            }
            if (a1 >= 0) {
                return -1;
            }
            if (b1 >= 0) {
                return 1;
            }
            return 0;
        });
        orderedKeys.sort((a, b) => (insightToSortingRank.get(b) ?? 0) - (insightToSortingRank.get(a) ?? 0));
        const newModel = {};
        for (const key of orderedKeys) {
            const model = insightSet.model[key];
            // @ts-expect-error Maybe someday typescript will be powerful enough to handle this.
            newModel[key] = model;
        }
        insightSet.model = newModel;
    }
    #computeInsightSet(insights, parsedTrace, context, options) {
        let id, urlString, navigation;
        if (context.navigation) {
            id = context.navigationId;
            urlString = context.navigation.args.data?.documentLoaderURL ?? parsedTrace.Meta.mainFrameURL;
            navigation = context.navigation;
        }
        else {
            id = Types.Events.NO_NAVIGATION;
            urlString = parsedTrace.Meta.mainFrameURL;
        }
        const model = {};
        for (const [name, insight] of Object.entries(TraceProcessor.getInsightRunners())) {
            let insightResult;
            try {
                insightResult = insight.generateInsight(parsedTrace, context);
                const navId = context.navigation?.args.data?.navigationId;
                if (navId) {
                    insightResult.navigationId = navId;
                }
            }
            catch (err) {
                insightResult = err;
            }
            Object.assign(model, { [name]: insightResult });
        }
        let url;
        try {
            url = new URL(urlString);
        }
        catch {
            // We're pretty sure this only happens for our test fixture: missing-url.json.gz. Shouldn't
            // happen for real traces.
            return;
        }
        const insightSet = {
            id,
            url,
            navigation,
            frameId: context.frameId,
            bounds: context.bounds,
            model,
        };
        insights.set(insightSet.id, insightSet);
        this.sortInsightSet(insights, insightSet, options.metadata ?? null);
    }
    /**
     * Run all the insights and set the result to `#insights`.
     */
    #computeInsights(parsedTrace, traceEvents, options) {
        this.#insights = new Map();
        const navigations = parsedTrace.Meta.mainFrameNavigations.filter(navigation => navigation.args.frame && navigation.args.data?.navigationId);
        // Check if there is a meaningful chunk of work happening prior to the first navigation.
        // If so, we run the insights on that initial bounds.
        // Otherwise, there are no navigations and we do a no-navigation insights pass on the entire trace.
        if (navigations.length) {
            const bounds = Helpers.Timing.traceWindowFromMicroSeconds(parsedTrace.Meta.traceBounds.min, navigations[0].ts);
            // When using "Record and reload" option, it typically takes ~5ms. So use 50ms to be safe.
            const threshold = Helpers.Timing.milliToMicro(50);
            if (bounds.range > threshold) {
                const context = {
                    bounds,
                    frameId: parsedTrace.Meta.mainFrameId,
                };
                this.#computeInsightSet(this.#insights, parsedTrace, context, options);
            }
            // If threshold is not met, then the very beginning of the trace is ignored by the insights engine.
        }
        else {
            const context = {
                bounds: parsedTrace.Meta.traceBounds,
                frameId: parsedTrace.Meta.mainFrameId,
            };
            this.#computeInsightSet(this.#insights, parsedTrace, context, options);
        }
        // Now run the insights for each navigation in isolation.
        for (const [i, navigation] of navigations.entries()) {
            // The above filter guarantees these are present.
            const frameId = navigation.args.frame;
            const navigationId = navigation.args.data?.navigationId;
            // The lantern sub-context is optional on InsightSetContext, so not setting it is OK.
            // This is also a hedge against an error inside Lantern resulting in breaking the entire performance panel.
            // Additionally, many trace fixtures are too old to be processed by Lantern.
            let lantern;
            try {
                lantern = this.#createLanternContext(parsedTrace, traceEvents, frameId, navigationId);
            }
            catch (e) {
                // Don't allow an error in constructing the Lantern graphs to break the rest of the trace processor.
                // Log unexpected errors, but suppress anything that occurs from a trace being too old.
                // Otherwise tests using old fixtures become way too noisy.
                const expectedErrors = [
                    'mainDocumentRequest not found',
                    'missing metric scores for main frame',
                    'missing metric: FCP',
                    'missing metric: LCP',
                    'No network requests found in trace',
                    'Trace is too old',
                ];
                if (!(e instanceof Lantern.Core.LanternError)) {
                    // If this wasn't a managed LanternError, the stack trace is likely needed for debugging.
                    console.error(e);
                }
                else if (!expectedErrors.some(err => e.message === err)) {
                    // To reduce noise from tests, only print errors that are not expected to occur because a trace is
                    // too old (for which there is no single check).
                    console.error(e);
                }
            }
            const min = navigation.ts;
            const max = i + 1 < navigations.length ? navigations[i + 1].ts : parsedTrace.Meta.traceBounds.max;
            const bounds = Helpers.Timing.traceWindowFromMicroSeconds(min, max);
            const context = {
                bounds,
                frameId,
                navigation,
                navigationId,
                lantern,
            };
            this.#computeInsightSet(this.#insights, parsedTrace, context, options);
        }
    }
}
/**
 * Some Handlers need data provided by others. Dependencies of a handler handler are
 * declared in the `deps` field.
 * @returns A map from trace event handler name to trace event handler whose entries
 * iterate in such a way that each handler is visited after its dependencies.
 */
export function sortHandlers(traceHandlers) {
    const sortedMap = new Map();
    const visited = new Set();
    const visitHandler = (handlerName) => {
        if (sortedMap.has(handlerName)) {
            return;
        }
        if (visited.has(handlerName)) {
            let stackPath = '';
            for (const handler of visited) {
                if (stackPath || handler === handlerName) {
                    stackPath += `${handler}->`;
                }
            }
            stackPath += handlerName;
            throw new Error(`Found dependency cycle in trace event handlers: ${stackPath}`);
        }
        visited.add(handlerName);
        const handler = traceHandlers[handlerName];
        if (!handler) {
            return;
        }
        const deps = handler.deps?.();
        if (deps) {
            deps.forEach(visitHandler);
        }
        sortedMap.set(handlerName, handler);
    };
    for (const handlerName of Object.keys(traceHandlers)) {
        visitHandler(handlerName);
    }
    return sortedMap;
}
//# sourceMappingURL=Processor.js.map