/**
 * Gem assistant (native). Full-screen camera, always listening. Rendering only: all
 * behavior comes from useAssistant(). Contract: docs/UI_CONTRACT.md §Assistant.
 */
import { CameraView } from 'expo-camera';
import { useState } from 'react';
import { Image, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAssistant } from '../../hooks/useAssistant';
import { frameAgeLabel, type AssistantPhase } from '../../logic/assistantState';
import { AppText, Button, Row, Spinner } from '../../ui/primitives';
import { theme } from '../../ui/theme';

const STATUS: Record<AssistantPhase, string> = {
  starting: 'Starting…',
  listening: 'Listening — ask me anything',
  hearing: 'Hearing you…',
  thinking: 'Thinking…',
  error: 'Connection problem',
};

export function AssistantScreen() {
  const { state, attachCamera, onCameraReady, micActive, micError, frames, retry, sendText, replay, dismiss } =
    useAssistant();
  const [typed, setTyped] = useState('');

  return (
    <View testID="assistant-screen" style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        testID="assistant-camera"
        ref={attachCamera}
        style={StyleSheet.absoluteFill}
        facing="back"
        animateShutter={false}
        onCameraReady={onCameraReady}
      />

      <SafeAreaView style={{ flex: 1, justifyContent: 'space-between' }} pointerEvents="box-none">
        <View style={{ padding: theme.space.md, gap: theme.space.xs }} accessibilityLiveRegion="polite">
          <View style={{ backgroundColor: theme.color.overlay, borderRadius: theme.radius.md, padding: theme.space.sm }}>
            <AppText variant="patient" tone="inverse" testID="assistant-status">
              {state.speaking ? 'Speaking…' : STATUS[state.phase]}
            </AppText>
            <AppText variant="small" tone="inverse" testID="assistant-mic">
              {micError ? `Microphone error: ${micError}` : micActive ? 'Mic on' : 'Mic off'}
            </AppText>
            <AppText variant="small" tone="inverse" testID="assistant-frames">
              {`Frames sent: ${frames.sent} · remembered: ${frames.remembered}${frames.lastChangeScore !== null ? ` · change ${frames.lastChangeScore.toFixed(2)}` : ''}`}
            </AppText>
            {state.lastTranscript ? (
              <AppText variant="body" tone="inverse" testID="assistant-heard">{`You said: “${state.lastTranscript}”`}</AppText>
            ) : null}
            {state.notice ? (
              <AppText variant="body" tone="inverse" testID="assistant-notice">{state.notice}</AppText>
            ) : null}
          </View>
          {state.phase === 'thinking' ? (
            <View testID="assistant-thinking" style={{ alignItems: 'flex-start' }}>
              <Spinner />
            </View>
          ) : null}
          {state.phase === 'error' ? (
            <View testID="assistant-error" style={{ backgroundColor: theme.color.background, borderRadius: theme.radius.md, padding: theme.space.sm }}>
              <AppText variant="patient" tone="danger">{state.error}</AppText>
              <Button testID="assistant-retry" label="Try again" onPress={retry} />
            </View>
          ) : null}
        </View>

        <Row style={{ padding: theme.space.md, flexWrap: 'nowrap' }}>
          <TextInput
            testID="assistant-text-input"
            accessibilityLabel="Type a question instead"
            placeholder="Or type a question…"
            placeholderTextColor={theme.color.textMuted}
            value={typed}
            onChangeText={setTyped}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: theme.touch.minHeight,
              backgroundColor: theme.color.background,
              borderRadius: theme.radius.md,
              paddingHorizontal: theme.space.md,
              fontSize: theme.font.body,
              color: theme.color.text,
            }}
          />
          <Button
            testID="assistant-send"
            label="Send"
            onPress={() => {
              sendText(typed);
              setTyped('');
            }}
            disabled={!typed.trim() || state.phase === 'thinking' || state.phase === 'starting'}
          />
        </Row>
      </SafeAreaView>

      {state.answer ? (
        <SafeAreaView
          testID="assistant-answer"
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.92)', padding: theme.space.md }]}
        >
          {frameAgeLabel(state.answer.frameAgeS) ? (
            <AppText variant="patient" tone="inverse" testID="assistant-answer-age">
              {frameAgeLabel(state.answer.frameAgeS)}
            </AppText>
          ) : null}
          {state.answer.imageUri ? (
            <Image
              testID="assistant-answer-image"
              source={{ uri: state.answer.imageUri }}
              style={{ flex: 1, width: '100%' }}
              resizeMode="contain"
              accessibilityLabel="Your camera view with Gem's markings"
            />
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <ScrollView
            testID="assistant-answer-box"
            style={{ maxHeight: 220, backgroundColor: theme.color.background, borderRadius: theme.radius.md, marginTop: theme.space.sm }}
            contentContainerStyle={{ padding: theme.space.md }}
          >
            <AppText variant="patient" testID="assistant-answer-text">{state.answer.answer}</AppText>
          </ScrollView>
          <Row style={{ marginTop: theme.space.sm }}>
            <View style={{ flex: 1 }}>
              <Button testID="assistant-replay" label={state.speaking ? 'Speaking…' : 'Read it again'} variant="secondary" onPress={replay} />
            </View>
            <View style={{ flex: 1 }}>
              <Button testID="assistant-dismiss" label="Dismiss" onPress={dismiss} />
            </View>
          </Row>
        </SafeAreaView>
      ) : null}
    </View>
  );
}
