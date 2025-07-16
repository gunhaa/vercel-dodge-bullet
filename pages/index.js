import React, { useState, useEffect, useRef, useCallback } from 'react';

// --- Firebase SDK Import ---
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, query, orderBy, limit, getDocs, serverTimestamp } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";


// --- Firebase 설정 ---
// TODO: config 변경 필요
const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
};

// --- Firebase 초기화 ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);


// --- 게임 상수 정의 ---
const GAME_WIDTH = 400;
const GAME_HEIGHT = 580;
const PLAYER_SIZE = 35;
const BULLET_SIZE = 15;
const ITEM_SIZE = 30;
const STAGE_DURATION = 60;
const DEBUG_STAGE_DURATION = 15;
const ITEM_LIFESPAN = 10000;
const GEM_LIFESPAN = 6000;

// --- 플레이어 상수 ---
const PLAYER_BASE_SPEED = 4.0; 
const PLAYER_HITBOX_PADDING = 5;

// 도우미 함수: 랜덤 숫자 생성
const getRandom = (min, max) => Math.random() * (max - min) + min;

// 게임 컴포넌트
const Game = () => {
    const [gameState, setGameState] = useState('lobby'); // lobby, playing, stageClear, gameOver
    const [gameData, setGameData] = useState(null);
    const [rankings, setRankings] = useState([]);
    const [userId, setUserId] = useState(null);
    const [playerId, setPlayerId] = useState('');
    
    // --- 조작 상태 관리 ---
    const targetPositionRef = useRef(null);
    const gameAreaRef = useRef(null);
    const gameLoopRef = useRef();

    // --- Player ID 생성 및 관리 ---
    useEffect(() => {
        let storedPlayerId = localStorage.getItem('crocoPlayerId');
        if (!storedPlayerId) {
            storedPlayerId = `Player_${crypto.randomUUID().substring(0, 8)}`;
            localStorage.setItem('crocoPlayerId', storedPlayerId);
        }
        setPlayerId(storedPlayerId);
    }, []);


    // Firebase 인증 처리
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, user => {
            if (user) {
                setUserId(user.uid);
            } else {
                signInAnonymously(auth).catch(error => console.error("익명 로그인 실패:", error));
            }
        });
        return () => unsubscribe();
    }, []);

    // 랭킹 데이터 가져오기 (Firestore 연동)
    const fetchRankings = useCallback(async () => {
        try {
            const rankingsCol = collection(db, "crocoGameRankings");
            const q = query(rankingsCol, orderBy("score", "desc"), limit(10));
            const querySnapshot = await getDocs(q);
            const fetchedRankings = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setRankings(fetchedRankings);
        } catch (error) {
            console.error("랭킹 정보 로딩 실패:", error);
            console.log("Firestore 색인 문제일 수 있습니다. Firestore 콘솔에서 'crocoGameRankings' 컬렉션의 'score' 필드에 대한 내림차순 색인을 확인하세요.");
        }
    }, []);

    // 랭킹 저장 함수 (Firestore 연동)
    const saveRanking = useCallback(async (playerName, score) => {
        if (!userId || !playerName || score === undefined) return;
        try {
            await addDoc(collection(db, "crocoGameRankings"), {
                playerId: playerName,
                userId: userId,
                score: Math.floor(score),
                createdAt: serverTimestamp() 
            });
            fetchRankings();
        } catch (error) {
            console.error("랭킹 저장 실패:", error);
        }
    }, [userId, fetchRankings]);

    useEffect(() => {
        if (gameState === 'lobby' || gameState === 'gameOver') {
            fetchRankings();
        }
    }, [gameState, fetchRankings]);
    
    // 게임 루프
    const gameLoop = useCallback(() => {
        setGameData(prevGameData => {
            if (!prevGameData || prevGameData.status !== 'playing') return prevGameData;

            let newGameData = JSON.parse(JSON.stringify(prevGameData));
            let player = newGameData.player;
            const now = Date.now();

            let speedMultiplier = 1.0; 
            if (newGameData.stage === 1) speedMultiplier = 0.8;
            else if (newGameData.stage === 3) speedMultiplier = 0.9;
            const currentPlayerSpeed = PLAYER_BASE_SPEED * speedMultiplier;

            // --- 터치/클릭 기반 플레이어 이동 ---
            if (player.lives > 0 && targetPositionRef.current) {
                const { x: targetX, y: targetY } = targetPositionRef.current;
                const dx = targetX - player.x;
                const dy = targetY - player.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < currentPlayerSpeed) {
                    player.x = targetX;
                    player.y = targetY;
                    targetPositionRef.current = null; // 목표 도달
                } else {
                    player.x += (dx / distance) * currentPlayerSpeed;
                    player.y += (dy / distance) * currentPlayerSpeed;
                }
            }

            // 1. 시간 및 스테이지 업데이트
            const timeInStageMs = now - newGameData.stageStartTime;
            const timeInStageSec = timeInStageMs / 1000;
            
            if (timeInStageSec >= newGameData.stageDuration && newGameData.stage < 6) {
                setGameState('stageClear');
                newGameData.status = 'stageClear';
                newGameData.remainingTime = 0;
                newGameData.pauseStartTime = now;
                return newGameData;
            }
            
            const effectiveElapsedTime = (now - newGameData.gameStartTime) - newGameData.totalPausedTime;
            const totalTime = Math.floor(effectiveElapsedTime / 1000);
            newGameData.totalTime = totalTime;
            newGameData.displayScore = player.score + effectiveElapsedTime * 0.01;
            newGameData.remainingTime = newGameData.stageDuration - Math.floor(timeInStageSec);

            // --- 총알 분열 로직 ---
            const bulletsToSplit = [];
            newGameData.bullets = newGameData.bullets.filter(b => {
                if (b.isSplitter && now >= b.splitAt) {
                    bulletsToSplit.push(b);
                    return false;
                }
                return true;
            });
            bulletsToSplit.forEach(b => {
                spawnCrossPattern(newGameData, b.x, b.y, 2.5);
            });

            newGameData.bullets = newGameData.bullets.map(b => {
                if (b.isHoming && player.lives > 0) {
                    const angle = Math.atan2(player.y - b.y, player.x - b.x);
                    b.dx += Math.cos(angle) * 0.05;
                    b.dy += Math.sin(angle) * 0.05;
                }
                return { ...b, x: b.x + b.dx, y: b.y + b.dy };
            }).filter(b => b.x > -BULLET_SIZE && b.x < newGameData.width && b.y > -BULLET_SIZE && b.y < newGameData.height);

            generateBullets(newGameData, now, timeInStageSec);

            if (now > newGameData.nextItemSpawnTime) {
                const itemTypes = ['shield', 'teleport', 'clear'];
                newGameData.items.push({
                    id: `i_${now}`, type: itemTypes[Math.floor(Math.random() * itemTypes.length)],
                    x: getRandom(50, newGameData.width - 50), y: getRandom(50, newGameData.height - 50),
                    expiresAt: now + ITEM_LIFESPAN
                });
                newGameData.nextItemSpawnTime = now + getRandom(5000, 10000);
            }
            
            newGameData.items = newGameData.items.filter(i => i.expiresAt > now);
            newGameData.mathGems = newGameData.mathGems.filter(s => s.expiresAt > now);
            
            if (newGameData.mathGems.length === 0) {
                 newGameData.mathGems.push(createMathGem(now, newGameData.width, newGameData.height));
            }
            
            newGameData.floatingTexts = newGameData.floatingTexts.filter(ft => ft.expiresAt > now);

            if (player.lives > 0 && !player.isInvincible) {
                const playerHitbox = {
                    x: player.x + PLAYER_HITBOX_PADDING, y: player.y + PLAYER_HITBOX_PADDING,
                    width: PLAYER_SIZE - 2 * PLAYER_HITBOX_PADDING, height: PLAYER_SIZE - 2 * PLAYER_HITBOX_PADDING
                };
                for (const bullet of newGameData.bullets) {
                    if (playerHitbox.x < bullet.x + BULLET_SIZE && playerHitbox.x + playerHitbox.width > bullet.x &&
                        playerHitbox.y < bullet.y + BULLET_SIZE && playerHitbox.y + playerHitbox.height > bullet.y) {
                        player.lives = 0;
                        player.isInvincible = true;
                        player.invincibleUntil = now + 2000;
                        break;
                    }
                }
            }
            newGameData.items = newGameData.items.filter(item => {
                if (player.lives > 0 && player.x < item.x + ITEM_SIZE && player.x + PLAYER_SIZE > item.x &&
                    player.y < item.y + ITEM_SIZE && player.y + PLAYER_SIZE > item.y) {
                    switch(item.type) {
                        case 'shield': player.isInvincible = true; player.invincibleUntil = now + 5000; break;
                        case 'teleport': player.x = getRandom(PLAYER_SIZE, newGameData.width - PLAYER_SIZE); player.y = getRandom(PLAYER_SIZE, newGameData.height - PLAYER_SIZE); break;
                        case 'clear': newGameData.bullets = []; break;
                    }
                    return false;
                }
                return true;
            });
            newGameData.mathGems = newGameData.mathGems.filter(gem => {
                if (player.lives > 0 && player.x < gem.x + ITEM_SIZE * 1.5 && player.x + PLAYER_SIZE > gem.x &&
                    player.y < gem.y + ITEM_SIZE * 1.5 && player.y + PLAYER_SIZE > gem.y) {
                    
                    let scoreChange = 0;
                    switch(gem.operator) {
                        case '+': scoreChange = gem.value1 + gem.value2; break;
                        case '-': scoreChange = gem.value1 - gem.value2; break;
                        case '*': scoreChange = gem.value1 * gem.value2; break;
                        case '/': scoreChange = gem.value2 !== 0 ? gem.value1 / gem.value2 : 0; break;
                    }
                    player.score += scoreChange;
                    player.score = Math.max(0, player.score);
                    newGameData.floatingTexts.push({
                        id: `ft_${now}`,
                        text: `${scoreChange >= 0 ? '+' : ''}${Math.floor(scoreChange)}`,
                        x: player.x, y: player.y,
                        expiresAt: now + 1500
                    });
                    return false;
                }
                return true;
            });
            
            if (player.isInvincible && now > player.invincibleUntil) {
                player.isInvincible = false;
                player.invincibleUntil = 0;
            }

            if (player.lives <= 0) {
                setGameState('gameOver');
                newGameData.status = 'gameOver';
                const finalElapsedTime = now - newGameData.gameStartTime - newGameData.totalPausedTime;
                const finalTotalTime = Math.floor(finalElapsedTime / 1000);
                const finalScore = player.score + (finalTotalTime * 10);
                newGameData.finalScore = finalScore;
                saveRanking(player.name, finalScore);
            }
            
            return newGameData;
        });
        gameLoopRef.current = requestAnimationFrame(gameLoop);
    }, [saveRanking]);

    // 수학 보석 생성
    const createMathGem = (now, width, height) => {
        const operators = ['+', '-', '*', '/'];
        const operator = operators[Math.floor(Math.random() * operators.length)];
        let value1 = Math.floor(getRandom(-9, 10));
        let value2 = Math.floor(getRandom(-9, 10));
        
        if (operator === '/' && value2 === 0) { value2 = 1; }
        const text = `${value1}${operator === '*' ? '×' : operator}${value2}`;
        return { id: `g_${now}`, x: getRandom(50, width - 50), y: getRandom(50, height - 50), expiresAt: now + GEM_LIFESPAN, operator, value1, value2, text };
    };

    // --- 총알 패턴 함수들 ---
    const spawnSideBullet = (gameData, speed, isSplitter = false) => {
        const b = { id: `b_${Date.now()}_${getRandom(0,999)}`, x: 0, y: 0, dx: 0, dy: 0, isSplitter: isSplitter, splitAt: isSplitter ? Date.now() + getRandom(1000, 2000) : 0 };
        const side = Math.floor(getRandom(0, 4));
        switch (side) {
            case 0: b.x = getRandom(0, gameData.width); b.y = -BULLET_SIZE; break;
            case 1: b.x = gameData.width; b.y = getRandom(0, gameData.height); break;
            case 2: b.x = getRandom(0, gameData.width); b.y = gameData.height; break;
            case 3: b.x = -BULLET_SIZE; b.y = getRandom(0, gameData.height); break;
        }
        const targetX = getRandom(0, gameData.width);
        const targetY = getRandom(0, gameData.height);
        let dx = targetX - b.x;
        let dy = targetY - b.y;
        const magnitude = Math.sqrt(dx * dx + dy * dy);
        if (magnitude > 0) { b.dx = (dx / magnitude) * speed; b.dy = (dy / magnitude) * speed; } 
        else { b.dx = 0; b.dy = speed; }
        gameData.bullets.push(b);
    };
    const spawnCrossPattern = (gameData, x, y, speed) => { for(let i=0; i<4; i++) { const a = (Math.PI / 2) * i; gameData.bullets.push({ id: `b_${Date.now()}_split_${i}`, x, y, dx: Math.cos(a) * speed, dy: Math.sin(a) * speed }); } };
    const spawnAimedBullet = (gameData, speed) => { const { player } = gameData; const x = getRandom(0, 1) > 0.5 ? -BULLET_SIZE : gameData.width + BULLET_SIZE, y = getRandom(0, gameData.height); const a = Math.atan2(player.y - y, player.x - x); gameData.bullets.push({ id: `b_${Date.now()}_aim`, x, y, dx: Math.cos(a) * speed, dy: Math.sin(a) * speed }); };
    const spawnHomingBullet = (gameData, speed) => { const x = getRandom(0, 1) > 0.5 ? -BULLET_SIZE : gameData.width + BULLET_SIZE, y = getRandom(0, gameData.height); gameData.bullets.push({ id: `b_${Date.now()}_homing`, x, y, dx: (x > 0 ? -speed : speed), dy: 0, isHoming: true }); };
    const spawnImpossibleWallPattern = (gameData, speed, timeInStage) => { const side = Math.floor(getRandom(0, 4)); const timeInCycle = timeInStage % 30; const isSecondHalf = timeInStage >= 30; const currentSpeed = speed * (isSecondHalf ? 1.5 : 1.0); const gapSize = PLAYER_SIZE * 2.2; const gapPosition = getRandom(PLAYER_SIZE, gameData.width - PLAYER_SIZE - gapSize); for (let i = 0; i < gameData.width; i += BULLET_SIZE * 1.5) { if (i > gapPosition && i < gapPosition + gapSize) continue; let b = { id: `b_${Date.now()}_${i}`, x: 0, y: 0, dx: 0, dy: 0 }; if (side < 2) { b.x = i; b.y = (side === 0 ? -BULLET_SIZE : gameData.height + BULLET_SIZE); b.dy = (side === 0 ? currentSpeed : -currentSpeed); } else { b.x = (side === 2 ? -BULLET_SIZE : gameData.width + BULLET_SIZE); b.y = i; b.dx = (side === 2 ? currentSpeed : -currentSpeed); } gameData.bullets.push(b); } };

    // 스테이지별 총알 생성 로직
    const generateBullets = (gameData, now, timeInStage) => {
        const { stage, lastBulletSpawn, lastHomingSpawn, lastSplitterSpawn, lastPatternSpawn, stageDuration } = gameData;
        let speed;
        switch(stage) {
            case 1: 
                // TODO: [스테이지 1] 총알 속도 조절
                speed = 1.8; 
                const stage1Interval = 1000 - (timeInStage / stageDuration) * 800; 
                if (now - lastBulletSpawn > Math.max(200, stage1Interval)) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } 
                break;
            case 2: 
                // TODO: [스테이지 2] 일반탄/유도탄 속도 조절
                speed = 2.0; 
                if (now - lastBulletSpawn > 700) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } 
                if (now - lastHomingSpawn > 3000) { spawnHomingBullet(gameData, speed * 0.7); gameData.lastHomingSpawn = now; } 
                break;
            case 3: 
                // TODO: [스테이지 3] 일반탄/분열탄 속도 조절
                speed = 2.2; 
                if (now - lastBulletSpawn > 700) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } 
                if (now - lastSplitterSpawn > 3000) { spawnSideBullet(gameData, speed, true); gameData.lastSplitterSpawn = now; } 
                break;
            case 4: 
                // TODO: [스테이지 4] 특수 총알 속도 조절
                speed = 2.5; 
                if (now - lastBulletSpawn > 600) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } 
                if (now - lastHomingSpawn > 2800) { spawnHomingBullet(gameData, speed * 0.75); gameData.lastHomingSpawn = now; } 
                if (now - lastSplitterSpawn > 2500) { spawnSideBullet(gameData, speed, true); gameData.lastSplitterSpawn = now; } 
                break;
            case 5: 
                // TODO: [스테이지 5] 특수 총알 속도 조절
                speed = 3.8; 
                if (now - lastBulletSpawn > 400) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } 
                if (now - lastPatternSpawn > 5000) { spawnImpossibleWallPattern(gameData, 2.5, timeInStage); gameData.lastPatternSpawn = now; } 
                break;
            default: 
                // TODO: [무한 모드] 총알 속도 조절
                const infiniteBonus = (stage - 6) * 50; 
                const spawnInterval = 300 - infiniteBonus; 
                speed = 4 + (stage - 6) * 0.2; 
                if (now - lastBulletSpawn > Math.max(50, spawnInterval)) { spawnSideBullet(gameData, speed, true); if(Math.random() < 0.2) spawnAimedBullet(gameData, speed); if(Math.random() < 0.1) spawnHomingBullet(gameData, speed * 0.8); gameData.lastBulletSpawn = now; } 
                break;
        }
    };
    
    useEffect(() => {
        if (gameState === 'playing') {
            gameLoopRef.current = requestAnimationFrame(gameLoop);
        } else if (gameLoopRef.current) {
            cancelAnimationFrame(gameLoopRef.current);
        }
        return () => { if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current); };
    }, [gameState, gameLoop]);
    
    // 게임 시작
    const handleStartGame = (startStage = 1, isDebug = false) => {
        const now = Date.now();
        const duration = isDebug ? DEBUG_STAGE_DURATION : STAGE_DURATION;
        
        setGameData({
            player: { name: playerId, lives: 1, score: 0, x: GAME_WIDTH / 2 - PLAYER_SIZE / 2, y: GAME_HEIGHT - PLAYER_SIZE * 2, isInvincible: false, invincibleUntil: 0 },
            bullets: [], items: [], mathGems: [], floatingTexts: [], status: 'playing',
            gameStartTime: now,
            stageStartTime: now,
            totalTime: 0,
            totalPausedTime: 0,
            pauseStartTime: 0,
            displayScore: 0,
            remainingTime: duration,
            stage: startStage, stageDuration: duration,
            width: GAME_WIDTH, height: GAME_HEIGHT,
            lastBulletSpawn: now, lastHomingSpawn: now, lastSplitterSpawn: now, lastPatternSpawn: now,
            nextItemSpawnTime: now + getRandom(5000, 10000),
            targetPosition: null,
        });
        setGameState('playing');
    };
    
    const handleNextStage = () => {
        setGameData(prevData => {
            const now = Date.now();
            const nextStage = prevData.stage + 1;
            const pausedDuration = now - prevData.pauseStartTime;
            const newTotalPausedTime = prevData.totalPausedTime + pausedDuration;
            return {
                ...prevData,
                player: { ...prevData.player, isInvincible: false, invincibleUntil: 0 },
                status: 'playing',
                bullets: [], items: [], mathGems: [], floatingTexts: [],
                stage: nextStage,
                stageStartTime: now,
                totalPausedTime: newTotalPausedTime,
                pauseStartTime: 0,
                remainingTime: prevData.stageDuration,
                lastBulletSpawn: now, lastHomingSpawn: now, lastSplitterSpawn: now, lastPatternSpawn: now,
                nextItemSpawnTime: now + getRandom(5000, 10000),
                targetPosition: null,
            };
        });
        setGameState('playing');
    };

    const handlePlayAgain = () => { setGameState('lobby'); setGameData(null); fetchRankings(); };
    
    // --- 터치/클릭 이벤트 핸들러 ---
    const handlePointerDown = (e) => {
        e.preventDefault();
        targetPositionRef.current = getPointerPosition(e);
    };

    const getPointerPosition = (e) => {
        if (!gameAreaRef.current) return null;
        const rect = gameAreaRef.current.getBoundingClientRect();
        const touch = e.touches ? e.touches[0] : e;
        return {
            x: touch.clientX - rect.left,
            y: touch.clientY - rect.top,
        };
    };

    // --- 렌더링 ---
    const renderLobby = () => ( <div className="w-full max-w-sm text-center bg-gray-800 p-8 rounded-xl shadow-lg"> <h1 className="text-4xl font-bold text-green-400 mb-2">봄바르딜로 크로코딜로를 구해줘 v4.0</h1> <p className="text-gray-300 mb-8">v4.00 for Mobile</p> <div className="mb-4 mt-8"> <p className="text-gray-400">플레이어 ID:</p> <p className="text-lg font-bold text-white">{playerId}</p> </div> <div className="space-y-4 mt-8"> <button onClick={() => handleStartGame(1, false)} className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-lg text-xl transition-transform transform hover:scale-105"> 게임 시작 </button> <div className="pt-4"> <h3 className="text-lg text-yellow-400 mb-2">[디버그: 스테이지 선택 (15초)]</h3> <div className="grid grid-cols-3 gap-2"> {[1, 2, 3, 4, 5, 6].map(stage => ( <button key={stage} onClick={() => handleStartGame(stage, true)} className="bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-3 rounded-lg"> S{stage} </button> ))} </div> </div> </div> <div className="mt-10"> <h2 className="text-2xl font-bold text-yellow-400 mb-4">🏆 학교 랭킹 🏆</h2> <div className="bg-gray-900 rounded-lg p-4 max-h-48 overflow-y-auto"> {rankings.length > 0 ? ( <ul className="space-y-2"> {rankings.map((r, index) => ( <li key={r.id} className={`flex justify-between items-center p-2 rounded ${index === 0 ? 'bg-yellow-500 text-gray-900 font-bold' : 'bg-gray-700'}`}> <span>{index + 1}. {r.playerId}</span> <span>{r.score} 점</span> </li> ))} </ul> ) : <p className="text-gray-400">랭킹을 불러오는 중...</p>} </div> </div> </div> );
    const renderGameOver = () => ( <div className="w-full max-w-sm text-center bg-gray-800 p-10 rounded-xl shadow-lg"> <h1 className="text-5xl font-bold text-red-500 mb-4">게임 오버</h1> <div className="bg-gray-700 p-4 rounded-lg mb-6"> <h2 className="text-xl text-yellow-400 mb-2">최종 점수</h2> {gameData && <p className="text-2xl text-white font-bold">{Math.floor(gameData.finalScore) || 0} 점</p>} </div> <div className="mt-6"> <h3 className="text-xl font-bold text-yellow-400 mb-2">🏆 Top 3 🏆</h3> <div className="space-y-2 text-white"> {rankings.slice(0, 3).map((r, i) => ( <div key={r.id} className="flex justify-between p-2 bg-gray-700 rounded-lg"> <span>{i+1}. {r.playerId}</span> <span>{r.score} 점</span> </div> ))} </div> </div> <button onClick={handlePlayAgain} className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 mt-8"> 로비로 돌아가기 </button> </div> );
    const renderStageClear = () => ( <div className="w-full max-w-sm text-center bg-gray-800 p-10 rounded-xl shadow-lg flex flex-col items-center"> <h1 className="text-3xl font-bold text-green-400 mb-8"> 🐊 스테이지 클리어! 🐊 </h1> <p className="text-xl text-white mb-4"> 클리어한 스테이지: <span className="font-bold text-yellow-400">{gameData.stage}</span> </p> <button onClick={handleNextStage} className="w-full bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-4 rounded-lg text-xl transition-transform transform hover:scale-105"> 다음 스테이지 진행하기 </button> </div> );
    
    const renderGame = () => {
        if (!gameData) return <div className="text-white">게임을 불러오는 중...</div>;
        const { player, bullets, items, mathGems, floatingTexts, remainingTime, stage, displayScore } = gameData;
        const itemEmojis = { shield: '🛡️', teleport: '🌀', clear: '💥' };

        return (
            <div className="flex flex-col items-center w-full h-full max-w-md mx-auto">
                <style>{`
                    @keyframes float-up { from { transform: translateY(0); opacity: 1; } to { transform: translateY(-60px); opacity: 0; } }
                    .floating-text { position: absolute; font-weight: bold; font-size: 1.25rem; animation: float-up 1.5s ease-out forwards; pointer-events: none; z-index: 10; }
                `}</style>
                <div className="w-full bg-gray-900 text-white p-2 rounded-t-lg flex justify-around items-center font-mono text-base">
                    <span>🔥 S{stage}</span>
                    <span>⏰ {stage > 5 ? '∞' : (remainingTime || 0)}</span>
                    <span className="w-28 text-right">⭐ {Math.floor(displayScore) || 0}</span>
                </div>
                <div 
                    ref={gameAreaRef}
                    className="relative bg-gray-800 border-4 border-gray-600 overflow-hidden w-full" 
                    style={{ aspectRatio: `${GAME_WIDTH} / ${GAME_HEIGHT}`}}
                    onMouseDown={handlePointerDown}
                    onTouchStart={handlePointerDown}
                >
                    <div className={`absolute ${player.isInvincible ? 'opacity-50' : ''}`} style={{ left: player.x, top: player.y, width: PLAYER_SIZE, height: PLAYER_SIZE, filter: player.isInvincible ? 'drop-shadow(0 0 5px cyan)' : 'none' }}>
                       <span className="text-3xl">{player.lives > 0 ? '🐊' : '💀'}</span>
                    </div>
                    {bullets.map(b => ( <div key={b.id} className="absolute rounded-full bg-red-500" style={{ left: b.x, top: b.y, width: BULLET_SIZE, height: BULLET_SIZE, filter: 'drop-shadow(0 0 5px red)' }} /> ))}
                    {items.map(i => ( <div key={i.id} className="absolute animate-bounce text-3xl" style={{ left: i.x, top: i.y, width: ITEM_SIZE, height: ITEM_SIZE, filter: 'drop-shadow(0 0 8px yellow)' }}>{itemEmojis[i.type]}</div> ))}
                    {mathGems.map(g => ( <div key={g.id} className="absolute animate-pulse text-sm font-bold text-white bg-purple-600 rounded-lg flex items-center justify-center p-1" style={{ left: g.x, top: g.y, minWidth: ITEM_SIZE * 1.5, height: ITEM_SIZE * 1.5, filter: 'drop-shadow(0 0 8px purple)' }}>{g.text}</div> ))}
                    {floatingTexts.map(ft => (
                        <div key={ft.id} className="floating-text" style={{ left: ft.x, top: ft.y, color: ft.text.startsWith('+') ? '#4ade80' : '#f87171' }}>
                            {ft.text}
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className="w-screen h-screen bg-black text-white flex flex-col items-center justify-center p-2 sm:p-4 font-sans">
            {gameState === 'lobby' && renderLobby()}
            {gameState === 'playing' && renderGame()}
            {gameState === 'gameOver' && renderGameOver()}
            {gameState === 'stageClear' && renderStageClear()}
        </div>
    );
};

export default function BombardilloCrocodilloPage() {
    return <Game />;
}

