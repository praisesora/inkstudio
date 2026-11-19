import { describe, it, expect, beforeEach } from 'vitest';
import {
  AutoAction,
  AutoActionExecutionContext,
  createDefaultAutoActionSets,
  executeAutoAction,
  exportAutoActionSetsJson,
  importAutoActionSetsJson,
} from '../autoActionEngine';
import {
  autoActionStoreActions,
  useAutoActionStore,
} from '../../stores/useAutoActionStore';
import {
  computeTimelapseDimensions,
  sampleTimelapseFrameIndices,
} from '../timelapseEngine';

describe('Auto Actions Macro Engine', () => {
  beforeEach(() => {
    useAutoActionStore.reset();
  });

  it('executes built-in Quick Auto-Shadow macro in order with single history transaction', async () => {
    const defaultSets = createDefaultAutoActionSets();
    const quickShadow = defaultSets[0].actions.find((a) => a.id === 'action-quick-shadow');
    expect(quickShadow).toBeDefined();

    const log: string[] = [];
    let activeId = 'layer-base';
    let historyGroupsBegun = 0;
    let historyGroupsEnded = 0;

    const ctx: AutoActionExecutionContext = {
      getActiveLayerId: () => activeId,
      createLayer: (name) => {
        activeId = `layer-${name || 'new'}`;
        log.push(`create-layer:${name}`);
        return activeId;
      },
      createFolder: (name) => {
        activeId = `folder-${name || 'new'}`;
        log.push(`create-folder:${name}`);
        return activeId;
      },
      duplicateLayer: (id) => log.push(`duplicate:${id}`),
      deleteLayer: (id) => log.push(`delete:${id}`),
      renameLayer: (id, name) => log.push(`rename:${id}:${name}`),
      setBlendMode: (id, mode) => log.push(`blend:${id}:${mode}`),
      setOpacity: (id, op) => log.push(`opacity:${id}:${op}`),
      setClipping: (id, clipped) => log.push(`clip:${id}:${clipped}`),
      fillLayer: (id, color) => log.push(`fill:${id}:${color}`),
      clearLayer: (id) => log.push(`clear:${id}`),
      mergeDown: () => log.push('merge-down'),
      beginHistoryGroup: () => {
        historyGroupsBegun++;
      },
      endHistoryGroup: () => {
        historyGroupsEnded++;
      },
    };

    const result = await executeAutoAction(quickShadow!, ctx);
    expect(result.errors).toEqual([]);
    expect(result.executedSteps).toBe(5);
    expect(result.skippedSteps).toBe(0);
    expect(historyGroupsBegun).toBe(1);
    expect(historyGroupsEnded).toBe(1);

    expect(log).toEqual([
      'create-layer:Shadow',
      'blend:layer-Shadow:multiply',
      'opacity:layer-Shadow:0.45',
      'clip:layer-Shadow:true',
      'fill:layer-Shadow:#7b8cde',
    ]);
  });

  it('skips disabled steps and isolates per-step execution errors', async () => {
    const customAction: AutoAction = {
      id: 'act-custom',
      name: 'Partial Run',
      createdAt: Date.now(),
      steps: [
        {
          id: 's1',
          type: 'create-layer',
          label: 'Create Layer',
          params: { name: 'Highlights' },
          enabled: true,
        },
        {
          id: 's2',
          type: 'fill-layer',
          label: 'Skipped Fill',
          params: { color: '#ffffff' },
          enabled: false,
        },
        {
          id: 's3',
          type: 'apply-filter',
          label: 'Failing Filter',
          params: { filterType: 'gaussian-blur' },
          enabled: true,
        },
        {
          id: 's4',
          type: 'set-opacity',
          label: 'Set Opacity',
          params: { opacity: 0.7 },
          enabled: true,
        },
      ],
    };

    const calls: string[] = [];
    let current = 'l0';
    let ended = false;

    const res = await executeAutoAction(customAction, {
      getActiveLayerId: () => current,
      createLayer: (name) => {
        current = `l-${name}`;
        calls.push(`create:${name}`);
        return current;
      },
      createFolder: () => {},
      duplicateLayer: () => {},
      deleteLayer: () => {},
      renameLayer: () => {},
      setBlendMode: () => {},
      setOpacity: (id, op) => calls.push(`opacity:${id}:${op}`),
      setClipping: () => {},
      fillLayer: () => calls.push('fill-should-not-run'),
      clearLayer: () => {},
      mergeDown: () => {},
      applyFilter: () => {
        throw new Error('Mock filter failure');
      },
      endHistoryGroup: () => {
        ended = true;
      },
    });

    expect(res.executedSteps).toBe(2);
    expect(res.skippedSteps).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('Mock filter failure');
    expect(calls).toEqual(['create:Highlights', 'opacity:l-Highlights:0.7']);
    expect(ended).toBe(true);
  });

  it('records commands into active Auto Action and round-trips Action Sets JSON', () => {
    const created = autoActionStoreActions.createAction('My Manga Macro');
    autoActionStoreActions.startRecording(created.id);
    autoActionStoreActions.recordStep('create-layer', 'New Layer', { name: 'Tone' });
    autoActionStoreActions.recordStep('set-blend-mode', 'Multiply', { blendMode: 'multiply' });
    autoActionStoreActions.stopRecording();
    // Should ignore steps after stopRecording
    autoActionStoreActions.recordStep('clear-layer', 'Ignored Step');

    const sets = useAutoActionStore.getState().sets;
    const found = sets.flatMap((s) => s.actions).find((a) => a.id === created.id);
    expect(found?.steps).toHaveLength(2);
    expect(found?.steps.map((s) => s.type)).toEqual(['create-layer', 'set-blend-mode']);

    const exported = exportAutoActionSetsJson(sets);
    const reimported = importAutoActionSetsJson(exported);
    const reimportedAction = reimported.flatMap((s) => s.actions).find((a) => a.id === created.id);
    expect(reimportedAction?.steps).toHaveLength(2);
  });
});

describe('Time-lapse Recording & Export Math', () => {
  it('computes even video dimensions for all aspect ratios and resolutions', () => {
    const orig = computeTimelapseDimensions(2480, 3508, 'original', '1080p');
    expect(orig.width % 2).toBe(0);
    expect(orig.height % 2).toBe(0);
    expect(orig.height).toBeLessThanOrEqual(1920);

    expect(computeTimelapseDimensions(2000, 2000, '16:9', '1080p')).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(computeTimelapseDimensions(2000, 2000, '9:16', '720p')).toEqual({
      width: 720,
      height: 1280,
    });
    expect(computeTimelapseDimensions(2000, 1000, '1:1', '720p')).toEqual({
      width: 720,
      height: 720,
    });
  });

  it('samples keyframes evenly across 15s / 30s / 60s / full durations', () => {
    const s15 = sampleTimelapseFrameIndices(120, '15s', 30);
    expect(s15).toHaveLength(450);
    expect(s15[0]).toBe(0);
    expect(s15[s15.length - 1]).toBe(119);

    const s30 = sampleTimelapseFrameIndices(50, '30s', 30);
    expect(s30).toHaveLength(900);
    expect(s30[0]).toBe(0);
    expect(s30[s30.length - 1]).toBe(49);

    const sFull = sampleTimelapseFrameIndices(200, 'full', 30);
    expect(sFull).toHaveLength(200);
    expect(sFull[0]).toBe(0);
    expect(sFull[199]).toBe(199);
  });
});
