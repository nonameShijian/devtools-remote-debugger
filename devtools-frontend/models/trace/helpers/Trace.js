// Copyright 2022 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
import * as Common from '../../../core/common/common.js';
import * as Platform from '../../../core/platform/platform.js';
import * as Types from '../types/types.js';
import { SyntheticEventsManager } from './SyntheticEvents.js';
import { eventTimingsMicroSeconds } from './Timing.js';
/**
 * Extracts the raw stack trace in known trace events. Most likely than
 * not you want to use `getZeroIndexedStackTraceForEvent`, which returns
 * the stack with zero based numbering. Since some trace events are
 * one based this function can yield unexpected results when used
 * indiscriminately.
 *
 * Note: this only returns the stack trace contained in the payload of
 * an event, which only contains the synchronous portion of the call
 * stack. If you want to obtain the whole stack trace you might need to
 * use the @see Trace.Extras.StackTraceForEvent util.
 */
export function stackTraceInEvent(event) {
    if (event.args?.data?.stackTrace) {
        return event.args.data.stackTrace;
    }
    if (event.args?.stackTrace) {
        return event.args.stackTrace;
    }
    if (Types.Events.isUpdateLayoutTree(event)) {
        return event.args.beginData?.stackTrace || null;
    }
    if (Types.Events.isFunctionCall(event)) {
        const data = event.args.data;
        if (!data) {
            return null;
        }
        const { columnNumber, lineNumber, url, scriptId, functionName } = data;
        if (lineNumber === undefined || functionName === undefined || columnNumber === undefined ||
            scriptId === undefined || url === undefined) {
            return null;
        }
        return [{ columnNumber, lineNumber, url, scriptId, functionName }];
    }
    if (Types.Events.isProfileCall(event)) {
        // Of type Protocol.Runtime.CallFrame, handle accordingly.
        const callFrame = event.callFrame;
        if (!callFrame) {
            return null;
        }
        const { columnNumber, lineNumber, url, scriptId, functionName } = callFrame;
        if (lineNumber === undefined || functionName === undefined || columnNumber === undefined ||
            scriptId === undefined || url === undefined) {
            return null;
        }
        return [{ columnNumber, lineNumber, url, scriptId, functionName }];
    }
    return null;
}
export function extractOriginFromTrace(firstNavigationURL) {
    const url = Common.ParsedURL.ParsedURL.fromString(firstNavigationURL);
    if (url) {
        // We do this to save some space in the toolbar - seeing the `www` is less
        // useful than seeing `foo.com` if it's truncated at narrow widths
        if (url.host.startsWith('www.')) {
            return url.host.slice(4);
        }
        return url.host;
    }
    return null;
}
// Each thread contains events. Events indicate the thread and process IDs, which are
// used to store the event in the correct process thread entry below.
export function addEventToProcessThread(event, eventsInProcessThread) {
    const { tid, pid } = event;
    let eventsInThread = eventsInProcessThread.get(pid);
    if (!eventsInThread) {
        eventsInThread = new Map();
    }
    let events = eventsInThread.get(tid);
    if (!events) {
        events = [];
    }
    events.push(event);
    eventsInThread.set(event.tid, events);
    eventsInProcessThread.set(event.pid, eventsInThread);
}
export function eventTimeComparator(a, b) {
    const aBeginTime = a.ts;
    const bBeginTime = b.ts;
    if (aBeginTime < bBeginTime) {
        return -1;
    }
    if (aBeginTime > bBeginTime) {
        return 1;
    }
    const aDuration = a.dur ?? 0;
    const bDuration = b.dur ?? 0;
    const aEndTime = aBeginTime + aDuration;
    const bEndTime = bBeginTime + bDuration;
    if (aEndTime > bEndTime) {
        return -1;
    }
    if (aEndTime < bEndTime) {
        return 1;
    }
    // If times are equal, prioritize profile calls over trace events,
    // since an exactly equal timestamp with a trace event is likely
    // indicates that the SamplesIntegrator meant to parent the trace
    // event with the profile call.
    if (Types.Events.isProfileCall(a) && !Types.Events.isProfileCall(b)) {
        return -1;
    }
    if (Types.Events.isProfileCall(b) && !Types.Events.isProfileCall(a)) {
        return 1;
    }
    return 0;
}
/**
 * Sorts all the events in place, in order, by their start time. If they have
 * the same start time, orders them by longest first.
 */
export function sortTraceEventsInPlace(events) {
    events.sort(eventTimeComparator);
}
/**
 * Returns an array of ordered events that results after merging the two
 * ordered input arrays.
 */
export function mergeEventsInOrder(eventsArray1, eventsArray2) {
    const result = [];
    let i = 0;
    let j = 0;
    while (i < eventsArray1.length && j < eventsArray2.length) {
        const event1 = eventsArray1[i];
        const event2 = eventsArray2[j];
        const compareValue = eventTimeComparator(event1, event2);
        if (compareValue <= 0) {
            result.push(event1);
            i++;
        }
        if (compareValue === 1) {
            result.push(event2);
            j++;
        }
    }
    while (i < eventsArray1.length) {
        result.push(eventsArray1[i++]);
    }
    while (j < eventsArray2.length) {
        result.push(eventsArray2[j++]);
    }
    return result;
}
export function getNavigationForTraceEvent(event, eventFrameId, navigationsByFrameId) {
    const navigations = navigationsByFrameId.get(eventFrameId);
    if (!navigations || eventFrameId === '') {
        // This event's navigation has been filtered out by the meta handler as a noise event
        // or contains an empty frameId.
        return null;
    }
    const eventNavigationIndex = Platform.ArrayUtilities.nearestIndexFromEnd(navigations, navigation => navigation.ts <= event.ts);
    if (eventNavigationIndex === null) {
        // This event's navigation has been filtered out by the meta handler as a noise event.
        return null;
    }
    return navigations[eventNavigationIndex];
}
export function extractId(event) {
    return event.id ?? event.id2?.global ?? event.id2?.local;
}
export function activeURLForFrameAtTime(frameId, time, rendererProcessesByFrame) {
    const processData = rendererProcessesByFrame.get(frameId);
    if (!processData) {
        return null;
    }
    for (const processes of processData.values()) {
        for (const processInfo of processes) {
            if (processInfo.window.min > time || processInfo.window.max < time) {
                continue;
            }
            return processInfo.frame.url;
        }
    }
    return null;
}
/**
 * @param node the node attached to the profile call. Here a node represents a function in the call tree.
 * @param profileId the profile ID that the sample came from that backs this call.
 * @param sampleIndex the index of the sample in the given profile that this call was created from
 * @param ts the timestamp of the profile call
 * @param pid the process ID of the profile call
 * @param tid the thread ID of the profile call
 *
 * See `panels/timeline/docs/profile_calls.md` for more context on how these events are created.
 */
export function makeProfileCall(node, profileId, sampleIndex, ts, pid, tid) {
    return {
        cat: '',
        name: 'ProfileCall',
        nodeId: node.id,
        args: {},
        ph: "X" /* Types.Events.Phase.COMPLETE */,
        pid,
        tid,
        ts,
        dur: Types.Timing.Micro(0),
        callFrame: node.callFrame,
        sampleIndex,
        profileId,
    };
}
/**
 * Matches beginning events with PairableAsyncEnd and PairableAsyncInstant (ASYNC_NESTABLE_INSTANT)
 * if provided, though currently only coming from Animations. Traces may contain multiple instant events so we need to
 * account for that.
 *
 * @returns {Map<string, MatchingPairableAsyncEvents>} Map of the animation's ID to it's matching events.
 */
export function matchEvents(unpairedEvents) {
    // map to store begin and end of the event
    const matchedPairs = new Map();
    // looking for start and end
    for (const event of unpairedEvents) {
        const syntheticId = getSyntheticId(event);
        if (syntheticId === undefined) {
            continue;
        }
        // Create a synthetic id to prevent collisions across categories.
        // Console timings can be dispatched with the same id, so use the
        // event name as well to generate unique ids.
        const otherEventsWithID = Platform.MapUtilities.getWithDefault(matchedPairs, syntheticId, () => {
            return { begin: null, end: null, instant: [] };
        });
        const isStartEvent = event.ph === "b" /* Types.Events.Phase.ASYNC_NESTABLE_START */;
        const isEndEvent = event.ph === "e" /* Types.Events.Phase.ASYNC_NESTABLE_END */;
        const isInstantEvent = event.ph === "n" /* Types.Events.Phase.ASYNC_NESTABLE_INSTANT */;
        if (isStartEvent) {
            otherEventsWithID.begin = event;
        }
        else if (isEndEvent) {
            otherEventsWithID.end = event;
        }
        else if (isInstantEvent) {
            if (!otherEventsWithID.instant) {
                otherEventsWithID.instant = [];
            }
            otherEventsWithID.instant.push(event);
        }
    }
    return matchedPairs;
}
function getSyntheticId(event) {
    const id = extractId(event);
    return id && `${event.cat}:${id}:${event.name}`;
}
export function createSortedSyntheticEvents(matchedPairs, syntheticEventCallback) {
    const syntheticEvents = [];
    for (const [id, eventsTriplet] of matchedPairs.entries()) {
        const beginEvent = eventsTriplet.begin;
        const endEvent = eventsTriplet.end;
        const instantEvents = eventsTriplet.instant;
        if (!beginEvent || !(endEvent || instantEvents)) {
            // This should never happen, the backend only creates the events once it
            // has them both (beginEvent & endEvent/instantEvents), so we should never get into this state.
            // If we do, something is very wrong, so let's just drop that problematic event.
            continue;
        }
        const triplet = { beginEvent, endEvent, instantEvents };
        /**
         * When trying to pair events with instant events present, there are times when these
         * ASYNC_NESTABLE_INSTANT ('n') don't have a corresponding ASYNC_NESTABLE_END ('e') event.
         * In these cases, pair without needing the endEvent.
         */
        function eventsArePairable(data) {
            const instantEventsMatch = data.instantEvents ? data.instantEvents.some(e => id === getSyntheticId(e)) : false;
            const endEventMatch = data.endEvent ? id === getSyntheticId(data.endEvent) : false;
            return Boolean(id) && (instantEventsMatch || endEventMatch);
        }
        if (!eventsArePairable(triplet)) {
            continue;
        }
        const targetEvent = endEvent || beginEvent;
        const event = SyntheticEventsManager.registerSyntheticEvent({
            rawSourceEvent: triplet.beginEvent,
            cat: targetEvent.cat,
            ph: targetEvent.ph,
            pid: targetEvent.pid,
            tid: targetEvent.tid,
            id,
            // Both events have the same name, so it doesn't matter which we pick to
            // use as the description
            name: beginEvent.name,
            dur: Types.Timing.Micro(targetEvent.ts - beginEvent.ts),
            ts: beginEvent.ts,
            args: {
                data: triplet,
            },
        });
        if (event.dur < 0) {
            // We have seen in the backend that sometimes animation events get
            // generated with multiple begin entries, or multiple end entries, and this
            // can cause invalid data on the performance panel, so we drop them.
            // crbug.com/1472375
            continue;
        }
        syntheticEventCallback?.(event);
        syntheticEvents.push(event);
    }
    return syntheticEvents.sort((a, b) => a.ts - b.ts);
}
export function createMatchedSortedSyntheticEvents(unpairedAsyncEvents, syntheticEventCallback) {
    const matchedPairs = matchEvents(unpairedAsyncEvents);
    const syntheticEvents = createSortedSyntheticEvents(matchedPairs, syntheticEventCallback);
    return syntheticEvents;
}
/**
 * Different trace events return line/column numbers that are 1 or 0 indexed.
 * This function knows which events return 1 indexed numbers and normalizes
 * them. The UI expects 0 indexed line numbers, so that is what we return.
 */
export function getZeroIndexedLineAndColumnForEvent(event) {
    // Some events emit line numbers that are 1 indexed, but the UI layer expects
    // numbers to be 0 indexed. So here, if the event matches a known 1-indexed
    // number event, we subtract one from the line and column numbers.
    // Otherwise, if the event has args.data.lineNumber/colNumber, we return it
    // as is.
    const numbers = getRawLineAndColumnNumbersForEvent(event);
    const { lineNumber, columnNumber } = numbers;
    switch (event.name) {
        // All these events have line/column numbers which are 1 indexed; so we
        // subtract to make them 0 indexed.
        case "FunctionCall" /* Types.Events.Name.FUNCTION_CALL */:
        case "EvaluateScript" /* Types.Events.Name.EVALUATE_SCRIPT */:
        case "v8.compile" /* Types.Events.Name.COMPILE */:
        case "v8.produceCache" /* Types.Events.Name.CACHE_SCRIPT */: {
            return {
                lineNumber: typeof lineNumber === 'number' ? lineNumber - 1 : undefined,
                columnNumber: typeof columnNumber === 'number' ? columnNumber - 1 : undefined,
            };
        }
        case "ProfileCall" /* Types.Events.Name.PROFILE_CALL */: {
            const callFrame = event.callFrame;
            return {
                lineNumber: typeof lineNumber === 'number' ? callFrame.lineNumber - 1 : undefined,
                columnNumber: typeof columnNumber === 'number' ? callFrame.columnNumber - 1 : undefined,
            };
        }
        default: {
            return numbers;
        }
    }
}
/**
 * Different trace events contain stack traces with line/column numbers
 * that are 1 or 0 indexed.
 * This function knows which events return 1 indexed numbers and normalizes
 * them. The UI expects 0 indexed line numbers, so that is what we return.
 *
 * Note: this only returns the stack trace contained in the payload of
 * an event, which only contains the synchronous portion of the call
 * stack. If you want to obtain the whole stack trace you might need to
 * use the @see Trace.Extras.StackTraceForEvent util.
 */
export function getZeroIndexedStackTraceForEvent(event) {
    const stack = stackTraceInEvent(event);
    if (!stack) {
        return null;
    }
    return stack.map(callFrame => {
        switch (event.name) {
            case "ScheduleStyleRecalculation" /* Types.Events.Name.SCHEDULE_STYLE_RECALCULATION */:
            case "InvalidateLayout" /* Types.Events.Name.INVALIDATE_LAYOUT */:
            case "FunctionCall" /* Types.Events.Name.FUNCTION_CALL */:
            case "UpdateLayoutTree" /* Types.Events.Name.UPDATE_LAYOUT_TREE */: {
                return makeZeroBasedCallFrame(callFrame);
            }
            default: {
                if (Types.Events.isUserTiming(event) || Types.Extensions.isSyntheticExtensionEntry(event)) {
                    return makeZeroBasedCallFrame(callFrame);
                }
            }
        }
        return callFrame;
    });
}
/**
 * Given a 1-based call frame creates a 0-based one.
 */
export function makeZeroBasedCallFrame(callFrame) {
    const normalizedCallFrame = { ...callFrame };
    normalizedCallFrame.lineNumber = callFrame.lineNumber && callFrame.lineNumber - 1;
    normalizedCallFrame.columnNumber = callFrame.columnNumber && callFrame.columnNumber - 1;
    return normalizedCallFrame;
}
/**
 * NOTE: you probably do not want this function! (Which is why it is not exported).
 *
 * Some trace events have 0 indexed line/column numbers, and others have 1
 * indexed. This function does NOT normalize them, but
 * `getZeroIndexedLineAndColumnNumbersForEvent` does. It is best to use that!
 *
 * @see {@link getZeroIndexedLineAndColumnForEvent}
 **/
function getRawLineAndColumnNumbersForEvent(event) {
    if (!event.args?.data) {
        return {
            lineNumber: undefined,
            columnNumber: undefined,
        };
    }
    let lineNumber = undefined;
    let columnNumber = undefined;
    if ('lineNumber' in event.args.data && typeof event.args.data.lineNumber === 'number') {
        lineNumber = event.args.data.lineNumber;
    }
    if ('columnNumber' in event.args.data && typeof event.args.data.columnNumber === 'number') {
        columnNumber = event.args.data.columnNumber;
    }
    return { lineNumber, columnNumber };
}
export function frameIDForEvent(event) {
    // There are a few events (for example UpdateLayoutTree, ParseHTML) that have
    // the frame stored in args.beginData
    // Rather than list them all we just check for the presence of the field, so
    // we are robust against future trace events also doing this.
    // This check seems very robust, but it also helps satisfy TypeScript and
    // prevents us against unexpected data.
    if (event.args && 'beginData' in event.args && typeof event.args.beginData === 'object' &&
        event.args.beginData !== null && 'frame' in event.args.beginData &&
        typeof event.args.beginData.frame === 'string') {
        return event.args.beginData.frame;
    }
    // Otherwise, we expect frame to be in args.data
    if (event.args?.data?.frame) {
        return event.args.data.frame;
    }
    // No known frame for this event.
    return null;
}
const DevToolsTimelineEventCategory = 'disabled-by-default-devtools.timeline';
export function isTopLevelEvent(event) {
    if (event.name === 'JSRoot' && event.cat === 'toplevel') {
        // This is used in createFakeTraceFromCpuProfile to insert a fake event prior to the
        // CPU Profile in order to ensure the trace isn't truncated. So if we see
        // this, we want to treat it as a top level event.
        // TODO(crbug.com/341234884): do we need this?
        return true;
    }
    return event.cat.includes(DevToolsTimelineEventCategory) && event.name === "RunTask" /* Types.Events.Name.RUN_TASK */;
}
function topLevelEventIndexEndingAfter(events, time) {
    let index = Platform.ArrayUtilities.upperBound(events, time, (time, event) => time - event.ts) - 1;
    while (index > 0 && !isTopLevelEvent(events[index])) {
        index--;
    }
    return Math.max(index, 0);
}
export function findUpdateLayoutTreeEvents(events, startTime, endTime) {
    const foundEvents = [];
    const startEventIndex = topLevelEventIndexEndingAfter(events, startTime);
    for (let i = startEventIndex; i < events.length; i++) {
        const event = events[i];
        if (!Types.Events.isUpdateLayoutTree(event)) {
            continue;
        }
        if (event.ts >= (endTime || Infinity)) {
            continue;
        }
        foundEvents.push(event);
    }
    return foundEvents;
}
export function findNextEventAfterTimestamp(candidates, ts) {
    const index = Platform.ArrayUtilities.nearestIndexFromBeginning(candidates, candidate => ts < candidate.ts);
    return index === null ? null : candidates[index];
}
export function findPreviousEventBeforeTimestamp(candidates, ts) {
    const index = Platform.ArrayUtilities.nearestIndexFromEnd(candidates, candidate => candidate.ts < ts);
    return index === null ? null : candidates[index];
}
/**
 * Iterates events in a tree hierarchically, from top to bottom,
 * calling back on every event's start and end in the order
 * dictated by the corresponding timestamp.
 *
 * Events are assumed to be in ascendent order by timestamp.
 *
 * Events with 0 duration are treated as instant events. These do not have a
 * begin and end, but will be passed to the config.onInstantEvent callback as
 * they are discovered. Do not provide this callback if you are not interested
 * in them.
 *
 * For example, given this tree, the following callbacks
 * are expected to be made in the following order
 * |---------------A---------------|
 *  |------B------||-------D------|
 *    |---C---|
 *
 * 1. Start A
 * 3. Start B
 * 4. Start C
 * 5. End C
 * 6. End B
 * 7. Start D
 * 8. End D
 * 9. End A
 *
 * By default, async events are skipped. This behaviour can be
 * overridden making use of the config.ignoreAsyncEvents parameter.
 */
export function forEachEvent(events, config) {
    const globalStartTime = config.startTime ?? Types.Timing.Micro(0);
    const globalEndTime = config.endTime || Types.Timing.Micro(Infinity);
    const ignoreAsyncEvents = config.ignoreAsyncEvents === false ? false : true;
    const stack = [];
    const startEventIndex = topLevelEventIndexEndingAfter(events, globalStartTime);
    for (let i = startEventIndex; i < events.length; i++) {
        const currentEvent = events[i];
        const currentEventTimings = eventTimingsMicroSeconds(currentEvent);
        if (currentEventTimings.endTime < globalStartTime) {
            continue;
        }
        if (currentEventTimings.startTime > globalEndTime) {
            break;
        }
        const isIgnoredAsyncEvent = ignoreAsyncEvents && Types.Events.isPhaseAsync(currentEvent.ph);
        if (isIgnoredAsyncEvent || Types.Events.isFlowPhase(currentEvent.ph)) {
            continue;
        }
        // If we have now reached an event that is after a bunch of events, we need
        // to call the onEndEvent callback for those events before moving on.
        let lastEventOnStack = stack.at(-1);
        let lastEventEndTime = lastEventOnStack ? eventTimingsMicroSeconds(lastEventOnStack).endTime : null;
        while (lastEventOnStack && lastEventEndTime && lastEventEndTime <= currentEventTimings.startTime) {
            stack.pop();
            config.onEndEvent(lastEventOnStack);
            lastEventOnStack = stack.at(-1);
            lastEventEndTime = lastEventOnStack ? eventTimingsMicroSeconds(lastEventOnStack).endTime : null;
        }
        // Now we have dealt with all events prior to this one, see if we need to care about this one.
        if (config.eventFilter && !config.eventFilter(currentEvent)) {
            // The user has chosen to filter this event out, so continue on and do nothing
            continue;
        }
        if (currentEventTimings.duration) {
            config.onStartEvent(currentEvent);
            stack.push(currentEvent);
        }
        else if (config.onInstantEvent) {
            // An event with 0 duration is an instant event.
            config.onInstantEvent(currentEvent);
        }
    }
    // Now we have finished looping over all events; any events remaining on the
    // stack need to have their onEndEvent called.
    while (stack.length) {
        const last = stack.pop();
        if (last) {
            config.onEndEvent(last);
        }
    }
}
// Parsed categories are cached to prevent calling cat.split()
// multiple times on the same categories string.
const parsedCategories = new Map();
export function eventHasCategory(event, category) {
    let parsedCategoriesForEvent = parsedCategories.get(event.cat);
    if (!parsedCategoriesForEvent) {
        parsedCategoriesForEvent = new Set(event.cat.split(',') || []);
    }
    return parsedCategoriesForEvent.has(category);
}
/**
 * This compares Types.Events.CallFrame with Protocol.Runtime.CallFrame and checks for equality.
 */
export function isMatchingCallFrame(eventFrame, nodeFrame) {
    return eventFrame.columnNumber === nodeFrame.columnNumber && eventFrame.lineNumber === nodeFrame.lineNumber &&
        String(eventFrame.scriptId) === nodeFrame.scriptId && eventFrame.url === nodeFrame.url &&
        eventFrame.functionName === nodeFrame.functionName;
}
export function eventContainsTimestamp(event, ts) {
    return event.ts <= ts && event.ts + (event.dur || 0) >= ts;
}
export function extractSampleTraceId(event) {
    if (!event.args) {
        return null;
    }
    if ('beginData' in event.args) {
        const beginData = event.args['beginData'];
        return beginData.sampleTraceId ?? null;
    }
    return event.args?.sampleTraceId ?? event.args?.data?.sampleTraceId ?? null;
}
//# sourceMappingURL=Trace.js.map