/**
 * All patient-capture logic: camera -> downscale -> POST /captures -> voice -> confirm.
 * Screens call this hook and render what it returns; they contain no logic of their own.
 */
import type { CameraView } from 'expo-camera';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { ApiError, NetworkError, api } from '../api/client';
import type { Protocol } from '../api/types';
import { PATIENT_ID, SLOW_NOTICE_MS } from '../config';
import { captureReducer, initialCaptureState, isBusy, type CaptureState } from '../logic/captureMachine';
import { newId } from '../services/ids';
import { prepareUpload } from '../services/image';
import { lineText, playCaptureVoice, playLine, stopVoice } from '../services/voice';

export interface CaptureController {
  state: CaptureState;
  busy: boolean;
  /** Callback ref for the camera view: <CameraView ref={attachCamera} /> */
  attachCamera: (camera: CameraView | null) => void;
  cameraReady: boolean;
  onCameraReady: () => void;
  /** Take a photo and analyze it. Ignored while busy (prevents double submission). */
  analyze: () => void;
  /** Patient says the read-back is right: store it (idempotent). */
  confirm: () => void;
  /** Patient says the read-back is wrong, or wants another go. */
  retake: () => void;
  /** Replay the last voice prompt. */
  repeatVoice: () => void;
}

function line(id: string): string {
  return lineText(id) ?? '';
}

export function useCapture(protocol: Protocol | null, onProtocolStale?: () => void): CaptureController {
  const [state, dispatch] = useReducer(captureReducer, initialCaptureState);
  const [cameraReady, setCameraReady] = useState(false);
  const cameraRef = useRef<CameraView | null>(null);
  const attachCamera = useCallback((camera: CameraView | null) => {
    cameraRef.current = camera;
  }, []);
  const sessionId = useRef(newId());
  const inFlight = useRef(false);
  const lastVoice = useRef<() => void>(() => undefined);

  useEffect(() => () => stopVoice(), []);

  const say = useCallback((fn: () => void) => {
    lastVoice.current = fn;
    fn();
  }, []);

  const analyze = useCallback(() => {
    if (inFlight.current || isBusy(state) || !protocol || !cameraRef.current) return;
    inFlight.current = true;
    stopVoice();
    dispatch({ type: 'ANALYZE_START', photo: null });
    const slowTimer = setTimeout(() => dispatch({ type: 'ANALYZE_SLOW' }), SLOW_NOTICE_MS);

    (async () => {
      let upload;
      try {
        const shot = await cameraRef.current!.takePictureAsync({ quality: 0.8, shutterSound: false });
        upload = await prepareUpload(shot);
        dispatch({ type: 'PHOTO_READY', photo: { uri: upload.uri, width: upload.width, height: upload.height } });
      } catch {
        dispatch({ type: 'ANALYZE_FAILED', target: 'unclear', message: line('retake_unclear') });
        say(() => void playLine('retake_unclear'));
        return;
      }
      try {
        const capture = await api.createCapture({
          protocol_id: protocol.protocol_id,
          patient_id: PATIENT_ID,
          session_id: sessionId.current,
          image_base64: upload.base64,
        });
        dispatch({ type: 'ANALYZE_DONE', capture, idempotencyKey: newId() });
        say(() => void playCaptureVoice(capture));
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'protocol_inactive' || err.code === 'protocol_not_found')) {
          dispatch({ type: 'ANALYZE_FAILED', target: 'error', message: 'Your study step was updated. Loading the new one…' });
          onProtocolStale?.();
        } else if (err instanceof ApiError && err.code === 'bad_image') {
          dispatch({ type: 'ANALYZE_FAILED', target: 'unclear', message: line('retake_unclear') });
          say(() => void playLine('retake_unclear'));
        } else if (err instanceof NetworkError) {
          dispatch({ type: 'ANALYZE_FAILED', target: 'offline', message: line('network_error') });
          say(() => void playLine('network_error'));
        } else {
          dispatch({ type: 'ANALYZE_FAILED', target: 'error', message: line('network_error') });
          say(() => void playLine('network_error'));
        }
      }
    })().finally(() => {
      clearTimeout(slowTimer);
      inFlight.current = false;
    });
  }, [state, protocol, onProtocolStale, say]);

  const confirm = useCallback(() => {
    if (inFlight.current || state.kind !== 'confirm') return;
    inFlight.current = true;
    const { capture, idempotencyKey } = state;
    dispatch({ type: 'CONFIRM_START' });
    api
      .confirmCapture(capture.capture_id, idempotencyKey)
      .then((res) => {
        dispatch({
          type: 'CONFIRM_DONE',
          event: res.event,
          flagged: res.result === 'flagged',
          message: res.voice_script,
          duplicate: false,
        });
        say(() => void playLine(res.voice_line_id, res.voice_script));
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'duplicate' && err.body.event) {
          const message = err.body.voice_script ?? line('already_saved');
          dispatch({
            type: 'CONFIRM_DONE',
            event: err.body.event,
            flagged: err.body.event.status === 'flagged',
            message,
            duplicate: true,
          });
          say(() => void playLine('already_saved', message));
        } else if (err instanceof ApiError && err.code === 'rejected') {
          const message = err.body.voice_script ?? line('retake_unusual');
          dispatch({ type: 'CONFIRM_REJECTED', message });
          say(() => void playLine('retake_unusual', message));
        } else if (err instanceof ApiError && err.status < 500) {
          const message = err.body.voice_script ?? line('retake_requested');
          dispatch({ type: 'CONFIRM_RETAKE', message });
          say(() => void playLine('retake_requested', message));
        } else {
          dispatch({ type: 'CONFIRM_FAILED', message: line('network_error') });
          say(() => void playLine('network_error'));
        }
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [state, say]);

  const retake = useCallback(() => {
    if (isBusy(state)) return;
    if (state.kind === 'confirm') {
      void api.discardCapture(state.capture.capture_id).catch(() => undefined);
      say(() => void playLine('retake_requested'));
    } else {
      stopVoice();
    }
    dispatch({ type: 'RESET' });
  }, [state, say]);

  const repeatVoice = useCallback(() => lastVoice.current(), []);

  return {
    state,
    busy: isBusy(state),
    attachCamera,
    cameraReady,
    onCameraReady: () => setCameraReady(true),
    analyze,
    confirm,
    retake,
    repeatVoice,
  };
}
