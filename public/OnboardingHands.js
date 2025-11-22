import * as THREE from 'three';

/**
 * OnboardingHands - Sistema de manos guía para onboarding
 * Muestra manos 3D animadas que demuestran gestos al usuario
 */
export class OnboardingHands {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.active = false;
        this.currentStep = 'drag'; // drag, rotate, scale, animate

        // Grupos para las manos
        this.leftHandGroup = new THREE.Group();
        this.rightHandGroup = new THREE.Group();

        // Materiales para las manos guía (blanco semi-transparente, más grueso)
        // Cambiado a MeshBasicMaterial porque usaremos cilindros en lugar de líneas
        this.handLineMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.9, // Aumentado de 0.7 a 0.9 para mejor visibilidad
            side: THREE.DoubleSide
        });

        this.fingertipMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.95 // Aumentado de 0.8 a 0.95
        });

        // Landmarks connections (MediaPipe hand structure)
        this.handConnections = [
            // Thumb
            [0, 1], [1, 2], [2, 3], [3, 4],
            // Index finger
            [0, 5], [5, 6], [6, 7], [7, 8],
            // Middle finger
            [0, 9], [9, 10], [10, 11], [11, 12],
            // Ring finger
            [0, 13], [13, 14], [14, 15], [15, 16],
            // Pinky
            [0, 17], [17, 18], [18, 19], [19, 20],
            // Palm
            [5, 9], [9, 13], [13, 17]
        ];

        // Índices de fingertips para círculos
        this.fingertipIndices = [0, 4, 8, 12, 16, 20];

        // Animación
        this.animationTime = 0;
        this.animationSpeed = 1.5; // velocidad de animación

        // Estados del onboarding
        this.onboardingSteps = ['scaleUp', 'scaleDown', 'drag'];
        this.currentStepIndex = 0;
        this.stepCompleted = false; // Flag para evitar detecciones múltiples
        this.handsHidden = false; // Flag para controlar si las manos ya fueron ocultadas

        // Para detectar que completó la acción de drag
        this.dragStartPosition = null;
        this.dragMovementThreshold = 50; // Píxeles de movimiento para considerar drag completo

        // Para detectar que completó la acción de scale
        this.scaleStartDistance = null;
        this.scaleMovementThreshold = 100; // Píxeles de cambio de distancia entre manos

        // Add groups to scene
        this.scene.add(this.leftHandGroup);
        this.scene.add(this.rightHandGroup);

        // Inicialmente ocultas
        this.leftHandGroup.visible = false;
        this.rightHandGroup.visible = false;
    }

    /**
     * Genera landmarks para una mano en posición base
     * Basado en la estructura de MediaPipe (21 landmarks)
     */
    generateBaseLandmarks(centerX, centerY, scale = 1, flipHorizontal = false) {
        // Posiciones base aproximadas de una mano (normalizadas)
        const base = [
            {x: 0.5, y: 0.7},   // 0: Wrist
            {x: 0.45, y: 0.6},  // 1: Thumb CMC
            {x: 0.4, y: 0.5},   // 2: Thumb MCP
            {x: 0.35, y: 0.4},  // 3: Thumb IP
            {x: 0.3, y: 0.3},   // 4: Thumb Tip
            {x: 0.55, y: 0.5},  // 5: Index MCP
            {x: 0.55, y: 0.4},  // 6: Index PIP
            {x: 0.55, y: 0.3},  // 7: Index DIP
            {x: 0.55, y: 0.2},  // 8: Index Tip
            {x: 0.6, y: 0.5},   // 9: Middle MCP
            {x: 0.6, y: 0.38},  // 10: Middle PIP
            {x: 0.6, y: 0.26},  // 11: Middle DIP
            {x: 0.6, y: 0.15},  // 12: Middle Tip
            {x: 0.65, y: 0.52}, // 13: Ring MCP
            {x: 0.65, y: 0.42}, // 14: Ring PIP
            {x: 0.65, y: 0.32}, // 15: Ring DIP
            {x: 0.65, y: 0.22}, // 16: Ring Tip
            {x: 0.7, y: 0.55},  // 17: Pinky MCP
            {x: 0.7, y: 0.48},  // 18: Pinky PIP
            {x: 0.7, y: 0.41},  // 19: Pinky DIP
            {x: 0.7, y: 0.34}   // 20: Pinky Tip
        ];

        // Transformar a coordenadas de pantalla (invertir Y para que vaya de abajo hacia arriba)
        return base.map(p => {
            const xOffset = flipHorizontal ? -(p.x - 0.5) : (p.x - 0.5);
            return {
                x: centerX + xOffset * scale,
                y: centerY - (p.y - 0.5) * scale, // Invertido con el signo negativo
                z: 5 // Delante de la escena
            };
        });
    }

    /**
     * Genera landmarks para animación de pinch (índice-pulgar)
     */
    generatePinchLandmarks(centerX, centerY, scale, pinchAmount, flipHorizontal = false) {
        const landmarks = this.generateBaseLandmarks(centerX, centerY, scale, flipHorizontal);

        // Animar índice (8) acercándose al pulgar (4)
        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];

        // Interpolar posición del índice hacia el pulgar
        landmarks[8].x = indexTip.x + (thumbTip.x - indexTip.x) * pinchAmount;
        landmarks[8].y = indexTip.y + (thumbTip.y - indexTip.y) * pinchAmount;

        // También mover un poco las articulaciones del índice
        landmarks[7].x += (thumbTip.x - indexTip.x) * pinchAmount * 0.5;
        landmarks[7].y += (thumbTip.y - indexTip.y) * pinchAmount * 0.5;
        landmarks[6].x += (thumbTip.x - indexTip.x) * pinchAmount * 0.3;
        landmarks[6].y += (thumbTip.y - indexTip.y) * pinchAmount * 0.3;

        return landmarks;
    }

    /**
     * Renderiza una mano en pantalla
     */
    renderHand(group, landmarks) {
        // Limpiar grupo anterior
        while (group.children.length) {
            const child = group.children[0];
            group.remove(child);
            if (child.geometry) child.geometry.dispose();
        }

        // Convertir landmarks a Vector3
        const points3D = landmarks.map(lm =>
            new THREE.Vector3(lm.x, lm.y, lm.z)
        );

        // Dibujar conexiones usando cilindros (para líneas gruesas que se vean bien)
        const lineThickness = 4; // Grosor de las líneas en píxeles
        this.handConnections.forEach(conn => {
            const p1 = points3D[conn[0]];
            const p2 = points3D[conn[1]];
            if (p1 && p2) {
                // Crear cilindro entre dos puntos
                const direction = new THREE.Vector3().subVectors(p2, p1);
                const length = direction.length();
                const cylinder = new THREE.CylinderGeometry(lineThickness, lineThickness, length, 8);
                const lineMesh = new THREE.Mesh(cylinder, this.handLineMaterial);

                // Posicionar el cilindro entre los dos puntos
                lineMesh.position.copy(p1).add(direction.multiplyScalar(0.5));

                // Rotar el cilindro para que apunte en la dirección correcta
                lineMesh.quaternion.setFromUnitVectors(
                    new THREE.Vector3(0, 1, 0),
                    direction.normalize()
                );

                group.add(lineMesh);
            }
        });

        // Dibujar fingertips (círculos) - Reducido un poco
        const fingertipRadius = 18; // Reducido de 25 a 18
        const wristRadius = 25; // Reducido de 35 a 25
        const circleSegments = 32; // Mantener suavidad

        this.fingertipIndices.forEach(index => {
            const pos = points3D[index];
            if (pos) {
                const radius = index === 0 ? wristRadius : fingertipRadius;
                const circleGeometry = new THREE.CircleGeometry(radius, circleSegments);
                const circle = new THREE.Mesh(circleGeometry, this.fingertipMaterial);
                circle.position.copy(pos);
                group.add(circle);
            }
        });

        group.visible = true;
    }

    /**
     * Inicia el onboarding con el primer paso (ahora es SCALE, no drag)
     */
    startDragOnboarding() {
        this.active = true;
        this.currentStepIndex = 0;
        this.currentStep = this.onboardingSteps[0];
        this.animationTime = 0;
    }

    /**
     * Avanza al siguiente paso del onboarding
     */
    nextStep() {
        this.currentStepIndex++;
        if (this.currentStepIndex < this.onboardingSteps.length) {
            this.currentStep = this.onboardingSteps[this.currentStepIndex];
            this.animationTime = 0;
            this.stepCompleted = false;
            this.handsHidden = false;
            this.dragStartPosition = null;
            this.scaleStartDistance = null;
            return true;
        } else {
            return false;
        }
    }

    /**
     * Obtiene el texto instructivo para el paso actual
     */
    getCurrentInstructionText() {
        switch(this.currentStep) {
            case 'drag':
                return '¡Junta tus dedos y arrastra el personaje!';
            case 'scaleUp':
                return '¡Usa ambas manos! Júntalas y sepáralas para hacerlo más grande';
            case 'scaleDown':
                return '¡Ahora acerca tus manos para hacerlo más pequeño!';
            default:
                return '';
        }
    }

    /**
     * Detiene el onboarding
     */
    stop() {
        this.active = false;
        this.leftHandGroup.visible = false;
        this.rightHandGroup.visible = false;
    }

    /**
     * Actualiza la animación (llamar en el loop de animación)
     */
    update(deltaTime) {
        if (!this.active) return;

        this.animationTime += deltaTime * this.animationSpeed;

        switch(this.currentStep) {
            case 'drag':
                this.updateDragAnimation();
                break;
            case 'scaleUp':
                this.updateScaleUpAnimation();
                break;
            case 'scaleDown':
                this.updateScaleDownAnimation();
                break;
        }
    }

    /**
     * Animación para demostrar el gesto de drag
     */
    updateDragAnimation() {
        const canvasWidth = this.camera.right - this.camera.left;
        const canvasHeight = this.camera.top - this.camera.bottom;

        // Ciclo de animación: open -> pinch -> drag -> release
        const cycle = this.animationTime % 4; // 4 segundos por ciclo

        let centerX, centerY, pinchAmount;

        if (cycle < 1) {
            // Fase 1: Mano abierta (0-1s)
            centerX = -canvasWidth * 0.15;
            centerY = 0;
            pinchAmount = 0;
        } else if (cycle < 1.5) {
            // Fase 2: Hacer pinch (1-1.5s)
            centerX = -canvasWidth * 0.15;
            centerY = 0;
            pinchAmount = (cycle - 1) / 0.5; // 0 a 1
        } else if (cycle < 3) {
            // Fase 3: Arrastrar mientras mantiene pinch (1.5-3s)
            const dragProgress = (cycle - 1.5) / 1.5;
            centerX = -canvasWidth * 0.15 + (canvasWidth * 0.3 * dragProgress);
            centerY = 0;
            pinchAmount = 1;
        } else {
            // Fase 4: Soltar pinch (3-4s)
            centerX = canvasWidth * 0.15;
            centerY = 0;
            pinchAmount = 1 - ((cycle - 3) / 1); // 1 a 0
        }

        // Generar y renderizar la mano
        const scale = canvasWidth * 0.25;
        const landmarks = this.generatePinchLandmarks(centerX, centerY, scale, pinchAmount);
        this.renderHand(this.rightHandGroup, landmarks);

        // Ocultar mano izquierda para drag (solo necesitamos una)
        this.leftHandGroup.visible = false;
    }

    /**
     * Animación para demostrar scale up (agrandar con dos manos)
     */
    updateScaleUpAnimation() {
        const canvasWidth = this.camera.right - this.camera.left;
        const canvasHeight = this.camera.top - this.camera.bottom;

        // Ciclo de animación: manos juntas con pinch -> separar manos
        const cycle = this.animationTime % 3; // 3 segundos por ciclo

        let leftX, rightX, centerY, pinchAmount;
        const scale = canvasWidth * 0.2;

        centerY = 0;

        if (cycle < 0.5) {
            // Fase 1: Manos juntas, hacer pinch (0-0.5s)
            const startGap = canvasWidth * 0.1;
            leftX = -startGap; // Izquierda
            rightX = startGap;  // Derecha
            pinchAmount = cycle / 0.5; // 0 a 1
        } else if (cycle < 2.5) {
            // Fase 2: Separar manos mientras mantienen pinch (0.5-2.5s)
            const separateProgress = (cycle - 0.5) / 2;
            const startGap = canvasWidth * 0.1;
            const endGap = canvasWidth * 0.3;
            const currentGap = startGap + (endGap - startGap) * separateProgress;
            leftX = -currentGap; // Izquierda
            rightX = currentGap;  // Derecha
            pinchAmount = 1;
        } else {
            // Fase 3: Soltar pinch (2.5-3s)
            const endGap = canvasWidth * 0.3;
            leftX = -endGap; // Izquierda
            rightX = endGap;  // Derecha
            pinchAmount = 1 - ((cycle - 2.5) / 0.5); // 1 a 0
        }

        // Generar y renderizar ambas manos
        // INTERCAMBIADO: rightLandmarks va a leftHandGroup y viceversa
        const leftLandmarks = this.generatePinchLandmarks(leftX, centerY, scale, pinchAmount, true);  // Con flip
        const rightLandmarks = this.generatePinchLandmarks(rightX, centerY, scale, pinchAmount, false); // Sin flip

        this.renderHand(this.rightHandGroup, leftLandmarks);  // Mano izquierda en rightHandGroup
        this.renderHand(this.leftHandGroup, rightLandmarks);  // Mano derecha en leftHandGroup
    }

    /**
     * Animación para demostrar scale down (achicar con dos manos)
     */
    updateScaleDownAnimation() {
        const canvasWidth = this.camera.right - this.camera.left;
        const canvasHeight = this.camera.top - this.camera.bottom;

        // Ciclo de animación: manos separadas con pinch -> juntar manos
        const cycle = this.animationTime % 3; // 3 segundos por ciclo

        let leftX, rightX, centerY, pinchAmount;
        const scale = canvasWidth * 0.2;

        centerY = 0;

        if (cycle < 0.5) {
            // Fase 1: Manos separadas, hacer pinch (0-0.5s)
            const startGap = canvasWidth * 0.3;
            leftX = -startGap; // Izquierda
            rightX = startGap;  // Derecha
            pinchAmount = cycle / 0.5; // 0 a 1
        } else if (cycle < 2.5) {
            // Fase 2: Juntar manos mientras mantienen pinch (0.5-2.5s)
            const joinProgress = (cycle - 0.5) / 2;
            const startGap = canvasWidth * 0.3;
            const endGap = canvasWidth * 0.1;
            const currentGap = startGap - (startGap - endGap) * joinProgress;
            leftX = -currentGap; // Izquierda
            rightX = currentGap;  // Derecha
            pinchAmount = 1;
        } else {
            // Fase 3: Soltar pinch (2.5-3s)
            const endGap = canvasWidth * 0.1;
            leftX = -endGap; // Izquierda
            rightX = endGap;  // Derecha
            pinchAmount = 1 - ((cycle - 2.5) / 0.5); // 1 a 0
        }

        // Generar y renderizar ambas manos
        // INTERCAMBIADO: rightLandmarks va a leftHandGroup y viceversa
        const leftLandmarks = this.generatePinchLandmarks(leftX, centerY, scale, pinchAmount, true);  // Con flip
        const rightLandmarks = this.generatePinchLandmarks(rightX, centerY, scale, pinchAmount, false); // Sin flip

        this.renderHand(this.rightHandGroup, leftLandmarks);  // Mano izquierda en rightHandGroup
        this.renderHand(this.leftHandGroup, rightLandmarks);  // Mano derecha en leftHandGroup
    }

    /**
     * Calcula la distancia entre el índice y el pulgar para detectar inicio de pinch
     */
    getPinchDistance(hand) {
        if (!hand.landmarks || hand.landmarks.length < 21) return null;

        const thumbTip = hand.landmarks[4];
        const indexTip = hand.landmarks[8];

        const dx = thumbTip.x - indexTip.x;
        const dy = thumbTip.y - indexTip.y;
        const dz = thumbTip.z - indexTip.z;

        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /**
     * Verifica si se deben ocultar las manos guía (cuando empieza el pinch)
     * Retorna true si las manos deben ocultarse
     */
    shouldHideHands(userHands) {
        if (!this.active || this.handsHidden) return false;

        const PINCH_START_THRESHOLD = 0.06;

        if (this.currentStep === 'drag') {
            if (userHands.length > 0) {
                const hand = userHands[0];
                const pinchDistance = this.getPinchDistance(hand);

                if (pinchDistance !== null && pinchDistance < PINCH_START_THRESHOLD) {
                    return true;
                }
            }
        } else if (this.currentStep === 'scaleUp' || this.currentStep === 'scaleDown') {
            if (userHands.length >= 2) {
                const hand0 = userHands[0];
                const hand1 = userHands[1];
                const pinchDistance0 = this.getPinchDistance(hand0);
                const pinchDistance1 = this.getPinchDistance(hand1);

                if (pinchDistance0 !== null && pinchDistance1 !== null &&
                    pinchDistance0 < PINCH_START_THRESHOLD && pinchDistance1 < PINCH_START_THRESHOLD) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Verifica si el usuario ha COMPLETADO la acción requerida (movimiento real)
     * Retorna true cuando la acción se completó
     */
    checkUserCompletion(userHands) {
        if (!this.active || this.stepCompleted) return false;

        const PINCH_START_THRESHOLD = 0.06;

        if (this.currentStep === 'drag') {
            if (userHands.length > 0) {
                const hand = userHands[0];
                const pinchDistance = this.getPinchDistance(hand);

                if (pinchDistance !== null && pinchDistance < PINCH_START_THRESHOLD && hand.pinchPointScreen) {
                    if (this.dragStartPosition === null) {
                        this.dragStartPosition = {
                            x: hand.pinchPointScreen.x,
                            y: hand.pinchPointScreen.y
                        };
                    } else {
                        const dx = hand.pinchPointScreen.x - this.dragStartPosition.x;
                        const dy = hand.pinchPointScreen.y - this.dragStartPosition.y;
                        const distance = Math.sqrt(dx * dx + dy * dy);

                        if (distance > this.dragMovementThreshold) {
                            this.stepCompleted = true;
                            return true;
                        }
                    }
                } else {
                    this.dragStartPosition = null;
                }
            }
        } else if (this.currentStep === 'scaleUp') {
            if (userHands.length >= 2) {
                const hand0 = userHands[0];
                const hand1 = userHands[1];
                const pinchDistance0 = this.getPinchDistance(hand0);
                const pinchDistance1 = this.getPinchDistance(hand1);

                if (pinchDistance0 !== null && pinchDistance1 !== null &&
                    pinchDistance0 < PINCH_START_THRESHOLD && pinchDistance1 < PINCH_START_THRESHOLD &&
                    hand0.pinchPointScreen && hand1.pinchPointScreen) {

                    const dx = hand1.pinchPointScreen.x - hand0.pinchPointScreen.x;
                    const dy = hand1.pinchPointScreen.y - hand0.pinchPointScreen.y;
                    const currentDistance = Math.sqrt(dx * dx + dy * dy);

                    if (this.scaleStartDistance === null) {
                        this.scaleStartDistance = currentDistance;
                    } else {
                        const distanceChange = currentDistance - this.scaleStartDistance;
                        if (distanceChange > this.scaleMovementThreshold) {
                            this.stepCompleted = true;
                            return true;
                        }
                    }
                } else {
                    this.scaleStartDistance = null;
                }
            }
        } else if (this.currentStep === 'scaleDown') {
            if (userHands.length >= 2) {
                const hand0 = userHands[0];
                const hand1 = userHands[1];
                const pinchDistance0 = this.getPinchDistance(hand0);
                const pinchDistance1 = this.getPinchDistance(hand1);

                if (pinchDistance0 !== null && pinchDistance1 !== null &&
                    pinchDistance0 < PINCH_START_THRESHOLD && pinchDistance1 < PINCH_START_THRESHOLD &&
                    hand0.pinchPointScreen && hand1.pinchPointScreen) {

                    const dx = hand1.pinchPointScreen.x - hand0.pinchPointScreen.x;
                    const dy = hand1.pinchPointScreen.y - hand0.pinchPointScreen.y;
                    const currentDistance = Math.sqrt(dx * dx + dy * dy);

                    if (this.scaleStartDistance === null) {
                        this.scaleStartDistance = currentDistance;
                    } else {
                        const distanceChange = this.scaleStartDistance - currentDistance;
                        if (distanceChange > this.scaleMovementThreshold) {
                            this.stepCompleted = true;
                            return true;
                        }
                    }
                } else {
                    this.scaleStartDistance = null;
                }
            }
        }

        return false;
    }
}
