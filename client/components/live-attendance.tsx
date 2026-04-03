import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  Platform,
  StatusBar,
  Dimensions,
  Pressable,
  ActivityIndicator
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
// import * as FaceDetector from 'expo-face-detector'; // Moved to lazy load to prevent crash if native module is missing
let FaceDetector: any = null;
try {
  FaceDetector = require('expo-face-detector');
} catch (e) {
  console.warn('ExpoFaceDetector native module not found. On-device pre-filtering disabled.');
}
import { useKiosk } from '../contexts/KioskContext';
import { PasswordModal } from './PasswordModal';
import { markAttendanceApi, MarkAttendanceInput } from '@/api/attendance';
import { getTimeRange, getSessionDuration, getRemainingMinutes } from '@/utils/timeSlots';

type LiveAttendanceProps = {
  sessionId: string;
  subject: string;
  section: string;
  sessionType: string;
  hours: number[];
  totalStudents: number;
  onAttendanceMarked: (data: any) => void;
  onClose: () => void;
  existingAttendance?: {
    presentStudents: number;
    absentStudents: number;
    markedStudents: Array<{
      id: string;
      name: string;
      rollNumber: string;
      isPresent: boolean;
    }>;
  };
};

type AttendanceStats = {
  present: number;
  absent: number;
  total: number;
};

export default function LiveAttendance({
  sessionId,
  subject,
  section,
  sessionType,
  hours,
  totalStudents,
  onAttendanceMarked,
  onClose,
  existingAttendance
}: LiveAttendanceProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [attendanceStats, setAttendanceStats] = useState<AttendanceStats>(() => {
    if (existingAttendance) {
      return {
        present: existingAttendance.presentStudents,
        absent: existingAttendance.absentStudents,
        total: totalStudents
      };
    }
    return { present: 0, absent: totalStudents, total: totalStudents };
  });
  const [isDetecting, setIsDetecting] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<'success' | 'duplicate' | 'notfound' | 'error' | null>(null);
  const [isButtonDisabled, setIsButtonDisabled] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [remainingMinutes, setRemainingMinutes] = useState<number | null>(null);
  const [hasFace, setHasFace] = useState(false);

  const cameraRef = useRef<CameraView>(null);
  const detectionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCapturingRef = useRef(false);
  const activeRequestsRef = useRef(0);
  const analyzingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markedStudentsRef = useRef<Set<string>>(new Set());
  const { isKioskMode, enableKioskMode, showPasswordModal, setShowPasswordModal } = useKiosk();

  useEffect(() => {
    if (existingAttendance) {
      const alreadyMarked = new Set(
        existingAttendance.markedStudents
          .filter(student => student.isPresent)
          .map(student => student.id)
      );
      markedStudentsRef.current = alreadyMarked;
    }
  }, [existingAttendance]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      enableKioskMode().catch(console.error);
    }
  }, []);

  const processFrameAsync = useCallback(async (base64: string) => {
    activeRequestsRef.current++;

    // Only show analyzing indicator if request takes > 800ms
    if (!analyzingTimerRef.current) {
      analyzingTimerRef.current = setTimeout(() => {
        setIsAnalyzing(true);
      }, 800);
    }

    try {
      const result = await markAttendanceApi({ sessionId, faceImageBase64: base64 });
      const isAlreadyMarked = result.message === 'Student already marked present';

      if (!isAlreadyMarked) {
        setAttendanceStats({
          present: result.attendance.present,
          absent: result.attendance.absent,
          total: result.attendance.total
        });
        markedStudentsRef.current.add(result.student.id);
        setStatusType('success');
        setStatusMessage(`${result.student.name} (${result.student.rollNumber || 'N/A'}) marked!`);
        onAttendanceMarked(result);
      } else {
        setStatusType('duplicate');
        setStatusMessage(`Already marked: ${result.student.name} (${result.student.rollNumber || 'N/A'})`);
      }
    } catch (apiError: any) {
      if (apiError.response?.status === 404 || apiError.response?.status === 400) {
        setStatusType('notfound');
        setStatusMessage('Not found');
      } else {
        setStatusType('error');
        setStatusMessage('Connection error');
      }
    } finally {
      activeRequestsRef.current--;

      // If no more active requests, clear the analyzing state and timer
      if (activeRequestsRef.current === 0) {
        if (analyzingTimerRef.current) {
          clearTimeout(analyzingTimerRef.current);
          analyzingTimerRef.current = null;
        }
        setIsAnalyzing(false);
      }

      // Handle status message clearing safely
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => {
        setStatusMessage(null);
        setStatusType(null);
        statusTimerRef.current = null;
      }, 2500);
    }
  }, [sessionId, onAttendanceMarked]);

  useEffect(() => {
    if (!isDetecting || !isInitialized || !cameraRef.current) {
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
        detectionIntervalRef.current = null;
      }
      return;
    }

    // Decoupled loop: captures frames every 2.2s without waiting for API response
    detectionIntervalRef.current = setInterval(async () => {
      if (isCapturingRef.current || !cameraRef.current || !isDetecting) return;

      try {
        isCapturingRef.current = true;

        // Fast capture: skip processing was stripping rotation, causing detection to fail on some devices
        const photo = await cameraRef.current.takePictureAsync({
          quality: 0.5,
          base64: true,
          skipProcessing: false,
          exif: true,
        });

        if (photo?.uri) {
          // On-device Face Detection (Pre-filter) - only run if module exists
          if (FaceDetector && FaceDetector.detectFacesAsync) {
            try {
              const detection = await FaceDetector.detectFacesAsync(photo.uri, {
                mode: FaceDetector.FaceDetectorMode.fast,
                detectLandmarks: FaceDetector.FaceDetectorLandmarks.none,
                runClassifications: FaceDetector.FaceDetectorClassifications.none,
              });

              if (detection.faces.length > 0) {
                setHasFace(true);
                if (photo.base64) {
                  processFrameAsync(photo.base64);
                }
              } else {
                setHasFace(false);
              }
            } catch (detectorError) {
              console.error("Face detection error:", detectorError);
              // Fallback: send anyway if detector fails
              if (photo.base64) processFrameAsync(photo.base64);
            }
          } else {
            // Fallback: No detector available, send all frames to server
            if (photo.base64) {
              processFrameAsync(photo.base64);
            }
          }
        }

        isCapturingRef.current = false;
      } catch (err) {
        isCapturingRef.current = false;
        console.error("Frame capture error:", err);
      }
    }, 2200);

    return () => {
      if (detectionIntervalRef.current) clearInterval(detectionIntervalRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (analyzingTimerRef.current) clearTimeout(analyzingTimerRef.current);
    };
  }, [isDetecting, isInitialized, processFrameAsync]);

  useEffect(() => {
    if (permission?.granted && cameraReady && !isInitialized) {
      const timer = setTimeout(() => setIsInitialized(true), 1000);
      return () => clearTimeout(timer);
    }
  }, [permission?.granted, cameraReady, isInitialized]);

  // Check remaining time
  useEffect(() => {
    const checkTime = () => {
      const remaining = getRemainingMinutes(hours);
      setRemainingMinutes(remaining);

      if (remaining <= 0 && isDetecting) {
        setIsDetecting(false);
        Alert.alert("Session Ended", "The attendance time slot has ended. Scanning has been stopped.");
      }
    };

    checkTime();
    const interval = setInterval(checkTime, 10000); // Check every 10s
    return () => clearInterval(interval);
  }, [hours, isDetecting]);

  const handleBackPress = () => {
    if (isKioskMode) setShowPasswordModal(true);
    else onClose();
  };

  const toggleDetection = () => {
    if (isButtonDisabled || !isInitialized) return;

    // Prevent starting if time is up
    if (remainingMinutes !== null && remainingMinutes <= 0) {
      Alert.alert("Session Ended", "Attendance cannot be taken after the time slot has ended.");
      return;
    }

    setIsButtonDisabled(true);
    setIsDetecting(prev => !prev);
    setTimeout(() => setIsButtonDisabled(false), 1000);
  };

  if (!permission?.granted) {
    return (
      <View style={styles.centerOverlay}>
        <Ionicons name="camera-outline" size={80} color="#2563EB" />
        <Text style={styles.permissionTitle}>Camera Required</Text>
        <Text style={styles.permissionSub}>To take live attendance, we need camera access.</Text>
        <Pressable style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>GRANT PERMISSION</Text>
        </Pressable>
        <Pressable onPress={onClose} style={styles.backLink}>
          <Text style={styles.backLinkText}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing="front"
        onCameraReady={() => setCameraReady(true)}
      />

      <View style={styles.overlay}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: Platform.OS === 'ios' ? 60 : 40 }]}>
          <Pressable onPress={handleBackPress} style={styles.iconBtn}>
            <Ionicons name="arrow-back" size={24} color="white" />
          </Pressable>

          <View style={styles.headerContent}>
            <Text style={styles.headerTitle}>{subject}</Text>
            <View style={styles.headerRow}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{section}</Text>
              </View>
              <Text style={styles.headerSub}>{getTimeRange(hours)}</Text>
            </View>
          </View>
        </View>

        {/* Status Indicators */}
        <View style={styles.statusRow}>
          <View style={[
            styles.statusPill,
            isDetecting ? styles.statusPillActive : styles.statusPillInactive
          ]}>
            <View style={[styles.dot, isDetecting && styles.dotActive]} />
            <Text style={styles.statusPillText}>
              {isDetecting ? 'SCANNING' : 'PAUSED'}
            </Text>
          </View>

          {isAnalyzing && (
            <View style={styles.processPill}>
              <ActivityIndicator size="small" color="#2563EB" />
              <Text style={styles.processPillText}>ANALYZING...</Text>
            </View>
          )}
        </View>

        {/* Center Guide */}
        <View style={styles.guideContainer}>
          <View style={styles.faceGuide} />
        </View>

        {/* Bottom Panel */}
        <View style={styles.bottomPanel}>
          {statusMessage && (
            <View style={[
              styles.banner,
              statusType === 'success' && styles.bannerSuccess,
              statusType === 'duplicate' && styles.bannerWarning,
              (statusType === 'notfound' || statusType === 'error') && styles.bannerError
            ]}>
              <Ionicons
                name={statusType === 'success' ? 'checkmark-circle' : 'alert-circle'}
                size={20}
                color="white"
              />
              <Text style={styles.bannerText}>{statusMessage}</Text>
            </View>
          )}

          {/* Time Remaining Warnings */}
          {remainingMinutes !== null && remainingMinutes <= 10 && remainingMinutes > 0 && (
            <View style={[
              styles.banner,
              remainingMinutes <= 1 ? styles.bannerCritical :
                remainingMinutes <= 5 ? styles.bannerWarning :
                  styles.bannerInfo
            ]}>
              <Ionicons
                name={remainingMinutes <= 5 ? "warning" : "information-circle"}
                size={20}
                color={remainingMinutes <= 5 ? "white" : "#2563EB"}
              />
              <Text style={[
                styles.bannerText,
                remainingMinutes > 5 && { color: '#1E293B' }
              ]}>
                {remainingMinutes <= 1 ? "URGENT: Session ending in < 1 minute!" :
                  remainingMinutes <= 5 ? `Warning: Session ending in ${remainingMinutes} mins` :
                    `Note: ${remainingMinutes} minutes remaining in session`}
              </Text>
            </View>
          )}

          {remainingMinutes !== null && remainingMinutes <= 0 && (
            <View style={[styles.banner, styles.bannerError]}>
              <Ionicons name="lock-closed" size={20} color="white" />
              <Text style={styles.bannerText}>Session Ended</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [
              styles.mainBtn,
              !isInitialized ? styles.btnLocked : isDetecting ? styles.btnStop : styles.btnStart,
              pressed && styles.pressed
            ]}
            onPress={toggleDetection}
            disabled={!isInitialized || isButtonDisabled}
          >
            {isButtonDisabled ? (
              <ActivityIndicator color="white" />
            ) : (
              <>
                <Ionicons
                  name={isDetecting ? 'pause-circle' : 'play-circle'}
                  size={24}
                  color="white"
                />
                <Text style={styles.mainBtnText}>
                  {isDetecting ? 'PAUSE SCANNING' : 'START SCANNING'}
                </Text>
              </>
            )}
          </Pressable>
        </View>
      </View>

      <PasswordModal
        visible={showPasswordModal}
        onClose={() => setShowPasswordModal(false)}
        onSuccess={onClose}
      />
    </View>
  );
}

const { width } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  camera: {
    flex: 1,
  },
  centerOverlay: {
    flex: 1,
    backgroundColor: 'white',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  permissionTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#1E293B',
    marginTop: 24,
    marginBottom: 8,
  },
  permissionSub: {
    fontSize: 16,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 40,
    lineHeight: 24,
  },
  permBtn: {
    backgroundColor: '#2563EB',
    width: '100%',
    height: 60,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2563EB',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
  },
  permBtnText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 1,
  },
  backLink: {
    marginTop: 20,
    padding: 12,
  },
  backLinkText: {
    color: '#64748B',
    fontWeight: '700',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.3)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  iconBtn: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerContent: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    padding: 12,
    borderRadius: 16,
  },
  headerTitle: {
    color: 'white',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    gap: 8,
  },
  badge: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    color: 'white',
    fontSize: 10,
    fontWeight: '900',
  },
  headerSub: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '600',
  },
  statusRow: {
    flexDirection: 'row',
    padding: 24,
    gap: 12,
    justifyContent: 'center',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.8)',
    gap: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  statusPillActive: {
    borderColor: '#10B981',
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
  },
  statusPillInactive: {
    borderColor: '#EF4444',
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  dotActive: {
    backgroundColor: '#10B981',
    shadowColor: '#10B981',
    shadowRadius: 4,
    shadowOpacity: 0.8,
  },
  statusPillText: {
    color: 'white',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1,
  },
  processPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'white',
    gap: 8,
    shadowColor: '#2563EB',
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  processPillText: {
    color: '#1E293B',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1,
  },
  guideContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceGuide: {
    width: width * 0.7,
    height: width * 0.9,
    borderRadius: 140,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    borderStyle: 'dashed',
  },
  bottomPanel: {
    padding: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    alignItems: 'center',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 16,
    marginBottom: 20,
    gap: 10,
    width: '100%',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
  },
  bannerSuccess: { backgroundColor: '#10B981' },
  bannerWarning: { backgroundColor: '#F59E0B' },
  bannerError: { backgroundColor: '#EF4444' },
  bannerInfo: { backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE' },
  bannerCritical: { backgroundColor: '#DC2626', borderWidth: 2, borderColor: '#991B1B' },
  bannerText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: -0.2,
  },
  mainBtn: {
    width: '100%',
    height: 72,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  btnStart: {
    backgroundColor: '#2563EB',
    shadowColor: '#2563EB',
    shadowOpacity: 0.4,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 8 },
  },
  btnStop: {
    backgroundColor: '#EF4444',
    shadowColor: '#EF4444',
    shadowOpacity: 0.4,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 8 },
  },
  btnLocked: {
    backgroundColor: '#64748B',
  },
  mainBtnText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 1,
  },
  pressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.9,
  },
});
