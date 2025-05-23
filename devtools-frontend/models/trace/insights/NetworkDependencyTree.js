// Copyright 2025 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
import * as i18n from '../../../core/i18n/i18n.js';
import * as Helpers from '../helpers/helpers.js';
import * as Types from '../types/types.js';
import { InsightCategory, } from './types.js';
export const UIStrings = {
    /**
     * @description Title of an insight that recommends avoiding chaining critical requests.
     */
    title: 'Network dependency tree',
    /**
     * @description Description of an insight that recommends avoiding chaining critical requests.
     */
    description: '[Avoid chaining critical requests](https://developer.chrome.com/docs/lighthouse/performance/critical-request-chains) by reducing the length of chains, reducing the download size of resources, or deferring the download of unnecessary resources to improve page load.',
    /**
     * @description Description of the warning that recommends avoiding chaining critical requests.
     */
    warningDescription: 'Avoid chaining critical requests by reducing the length of chains, reducing the download size of resources, or deferring the download of unnecessary resources to improve page load.',
    /**
     * @description Text status indicating that there isn't long chaining critical network requests.
     */
    noNetworkDependencyTree: 'No rendering tasks impacted by network dependencies',
    /**
     * @description Text for the maximum critical path latency. This refers to the longest chain of network requests that
     * the browser must download before it can render the page.
     */
    maxCriticalPathLatency: 'Max critical path latency:'
};
const str_ = i18n.i18n.registerUIStrings('models/trace/insights/NetworkDependencyTree.ts', UIStrings);
export const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);
// XHRs are fetched at High priority, but we exclude them, as they are unlikely to be critical
// Images are also non-critical.
const nonCriticalResourceTypes = new Set([
    "Image" /* Protocol.Network.ResourceType.Image */,
    "XHR" /* Protocol.Network.ResourceType.XHR */,
    "Fetch" /* Protocol.Network.ResourceType.Fetch */,
    "EventSource" /* Protocol.Network.ResourceType.EventSource */,
]);
function finalize(partialModel) {
    return {
        insightKey: "NetworkDependencyTree" /* InsightKeys.NETWORK_DEPENDENCY_TREE */,
        strings: UIStrings,
        title: i18nString(UIStrings.title),
        description: i18nString(UIStrings.description),
        category: InsightCategory.LCP,
        state: partialModel.rootNodes.length > 0 ? 'fail' : 'pass',
        ...partialModel,
    };
}
function isCritical(request, context) {
    // The main resource is always critical.
    if (request.args.data.requestId === context.navigationId) {
        return true;
    }
    // Treat any preloaded resource as non-critical
    if (request.args.data.isLinkPreload) {
        return false;
    }
    // Iframes are considered High Priority but they are not render blocking
    const isIframe = request.args.data.resourceType === "Document" /* Protocol.Network.ResourceType.Document */ &&
        request.args.data.frame !== context.frameId;
    if (nonCriticalResourceTypes.has(request.args.data.resourceType) || isIframe ||
        // Treat any missed images, primarily favicons, as non-critical resources
        request.args.data.mimeType.startsWith('image/')) {
        return false;
    }
    // Requests that have no initiatorRequest are typically ambiguous late-load assets.
    // Even on the off chance they were important, we don't have any parent to display for them.
    const initiatorUrl = request.args.data.initiator?.url || Helpers.Trace.getZeroIndexedStackTraceForEvent(request)?.at(0)?.url;
    if (!initiatorUrl) {
        return false;
    }
    const isBlocking = Helpers.Network.isSyntheticNetworkRequestEventRenderBlocking(request);
    const isHighPriority = Helpers.Network.isSyntheticNetworkRequestHighPriority(request);
    return isHighPriority || isBlocking;
}
export function generateInsight(_parsedTrace, context) {
    if (!context.navigation) {
        return finalize({
            rootNodes: [],
            maxTime: Types.Timing.Micro(0),
        });
    }
    const rootNodes = [];
    const relatedEvents = new Map();
    let maxTime = Types.Timing.Micro(0);
    let longestChain = [];
    function addChain(path) {
        if (path.length === 0) {
            return;
        }
        const initialRequest = path[0];
        const lastRequest = path[path.length - 1];
        const totalChainTime = Types.Timing.Micro(lastRequest.ts + lastRequest.dur - initialRequest.ts);
        if (totalChainTime > maxTime) {
            maxTime = totalChainTime;
            longestChain = path;
        }
        let currentNodes = rootNodes;
        for (let depth = 0; depth < path.length; ++depth) {
            const request = path[depth];
            // find the request
            let found = currentNodes.find(node => node.request === request);
            if (!found) {
                const timeFromInitialRequest = Types.Timing.Micro(request.ts + request.dur - initialRequest.ts);
                found = {
                    request,
                    timeFromInitialRequest,
                    children: [],
                };
                currentNodes.push(found);
            }
            if (request === lastRequest) {
                found.chain = path;
            }
            // TODO(b/372897712) Switch the UIString to markdown.
            relatedEvents.set(request, depth < 2 ? [] : [i18nString(UIStrings.warningDescription)]);
            currentNodes = found.children;
        }
    }
    // By default `traverse` will discover nodes in BFS-order regardless of dependencies, but
    // here we need traversal in a topological sort order. We'll visit a node only when its
    // dependencies have been met.
    const seenNodes = new Set();
    function getNextNodes(node) {
        return node.getDependents().filter(n => n.getDependencies().every(d => seenNodes.has(d)));
    }
    context.lantern?.graph.traverse((node, traversalPath) => {
        seenNodes.add(node);
        if (node.type !== 'network') {
            return;
        }
        const networkNode = node;
        if (!isCritical(networkNode.rawRequest, context)) {
            return;
        }
        const networkPath = traversalPath.filter(node => node.type === 'network').reverse().map(node => node.rawRequest);
        // Ignore if some ancestor is not a critical request.
        if (networkPath.some(request => (!isCritical(request, context)))) {
            return;
        }
        // Ignore non-network things (like data urls).
        if (node.isNonNetworkProtocol) {
            return;
        }
        addChain(networkPath);
    }, getNextNodes);
    // Mark the longest chain
    if (longestChain.length > 0) {
        let currentNodes = rootNodes;
        for (const request of longestChain) {
            const found = currentNodes.find(node => node.request === request);
            if (found) {
                found.isLongest = true;
                currentNodes = found.children;
            }
            else {
                console.error('Some request in the longest chain is not found');
            }
        }
    }
    return finalize({
        rootNodes,
        maxTime,
        relatedEvents,
    });
}
//# sourceMappingURL=NetworkDependencyTree.js.map