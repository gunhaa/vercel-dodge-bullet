import React, { useState, useEffect, useRef, useCallback } from 'react';

// --- Firebase SDK Imports ---
// Using modular imports for better tree-shaking
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, query, getDocs, serverTimestamp, setDoc, doc, getDoc, updateDoc, deleteDoc, onSnapshot, where, limit, orderBy } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from "firebase/auth";

// --- Firebase 설정 ---
const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
};

// --- Firebase Initialization ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const appId = firebaseConfig.appId || (typeof __app_id !== 'undefined' ? __app_id : 'default-app-id');

// --- Game Constants ---
const GAME_WIDTH = 400;
const GAME_HEIGHT = 580;
const PLAYER_SIZE = 35;
const BULLET_SIZE = 15;
const ITEM_SIZE = 30;
const STAGE_DURATION = 60;
const DEBUG_STAGE_DURATION = 15;
const ITEM_LIFESPAN = 10000;
const GEM_LIFESPAN = 6000;

// --- Player Constants ---
const PLAYER_BASE_SPEED = 250; // Adjusted speed for click-to-move
const PLAYER_HITBOX_PADDING = 5;

// --- Helper Function ---
const getRandom = (min, max) => Math.random() * (max - min) + min;

// --- Main Game Component ---
const Game = () => {
    // --- State Management ---
    const [gameState, setGameState] = useState('lobby'); // lobby, playing, stageClear, gameOver
    const [rankings, setRankings] = useState([]);
    const [userId, setUserId] = useState(null);
    const [playerId, setPlayerId] = useState('');
    const [uiData, setUiData] = useState({ score: 0, time: 0, stage: 0 });

    // --- Refs for Game Logic (to avoid re-renders) ---
    const gameDataRef = useRef(null);
    const targetPositionRef = useRef(null);
    const isPointerDownRef = useRef(false);
    const canvasRef = useRef(null);
    const gameLoopRef = useRef();
    const lastFrameTimeRef = useRef();
    const lastUiUpdateTimeRef = useRef(0);

    // --- Player ID Management ---
    useEffect(() => {
        let storedPlayerId = localStorage.getItem('crocoPlayerId');
        if (!storedPlayerId) {
            storedPlayerId = `Player_${crypto.randomUUID().substring(0, 8)}`;
            localStorage.setItem('crocoPlayerId', storedPlayerId);
        }
        setPlayerId(storedPlayerId);
    }, []);

    // --- Firebase Authentication ---
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                setUserId(user.uid);
            } else {
                try {
                    // Use the provided token if available, otherwise sign in anonymously
                    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                        await signInWithCustomToken(auth, __initial_auth_token);
                    } else {
                        await signInAnonymously(auth);
                    }
                } catch (error) {
                    console.error("Authentication failed:", error);
                }
            }
        });
        return () => unsubscribe();
    }, []);

    // --- Firestore Rankings Path ---
    const getRankingsCollection = useCallback(() => {
        // Use the appId from the config for the collection path
        return collection(db, `artifacts/${appId}/public/data/crocoGameRankings`);
    }, []);

    // --- Fetch Rankings from Firestore ---
    const fetchRankings = useCallback(async () => {
        try {
            const q = query(getRankingsCollection(), orderBy("score", "desc"), limit(10));
            const querySnapshot = await getDocs(q);
            const fetchedRankings = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setRankings(fetchedRankings);
        } catch (error) {
            console.error("Failed to load rankings:", error);
            console.log("This might be an indexing issue. Ensure 'score' has a descending index in your Firestore rules for the collection.");
        }
    }, [getRankingsCollection]);

    // --- Save Ranking to Firestore ---
    const saveRanking = useCallback(async (playerName, score) => {
        if (!userId || !playerName || score === undefined) return;
        try {
            await addDoc(getRankingsCollection(), {
                playerId: playerName,
                userId: userId,
                score: Math.floor(score),
                createdAt: serverTimestamp()
            });
            fetchRankings(); // Refresh rankings after saving
        } catch (error) {
            console.error("Failed to save ranking:", error);
        }
    }, [userId, fetchRankings, getRankingsCollection]);

    // --- Fetch rankings on lobby/game over ---
    useEffect(() => {
        if (gameState === 'lobby' || gameState === 'gameOver') {
            fetchRankings();
        }
    }, [gameState, fetchRankings]);

    // --- Drawing Logic on Canvas ---
    const draw = useCallback((ctx) => {
        if (!gameDataRef.current) return;

        // Clear canvas and draw background
        ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        ctx.fillStyle = '#1f2937'; // bg-gray-800
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

        const { player, bullets, items, mathGems, floatingTexts } = gameDataRef.current;

        // Draw Player
        ctx.save();
        if (player.isInvincible) {
            ctx.globalAlpha = 0.5;
            ctx.shadowColor = 'cyan';
            ctx.shadowBlur = 15;
        }
        ctx.font = `${PLAYER_SIZE}px sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(player.lives > 0 ? '🐊' : '💀', player.x, player.y);
        ctx.restore();

        // Draw Bullets
        ctx.fillStyle = '#ef4444'; // bg-red-500
        bullets.forEach(b => {
            ctx.beginPath();
            ctx.arc(b.x + BULLET_SIZE / 2, b.y + BULLET_SIZE / 2, BULLET_SIZE / 2, 0, Math.PI * 2);
            ctx.fill();
        });

        // Draw Items
        const itemEmojis = { shield: '🛡️', '꽝': '❓', clear: '💥' };
        ctx.font = `${ITEM_SIZE}px sans-serif`;
        items.forEach(i => {
            ctx.fillText(itemEmojis[i.type], i.x, i.y);
        });

        // Draw Math Gems
        mathGems.forEach(g => {
            const gemWidth = ITEM_SIZE * 1.5;
            const gemHeight = ITEM_SIZE * 1.5;
            ctx.fillStyle = '#9333ea'; // bg-purple-600
            ctx.fillRect(g.x, g.y, gemWidth, gemHeight);
            ctx.fillStyle = 'white';
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(g.text, g.x + gemWidth / 2, g.y + gemHeight / 2);
        });
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        // Draw Floating Texts
        const now = Date.now();
        floatingTexts.forEach(ft => {
            const life = (ft.expiresAt - now) / 1500;
            if (life > 0) {
                ctx.save();
                ctx.globalAlpha = life;
                ctx.font = 'bold 20px sans-serif';
                ctx.fillStyle = ft.text.startsWith('+') ? '#4ade80' : '#f87171';
                ctx.fillText(ft.text, ft.x, ft.y - (1 - life) * 60);
                ctx.restore();
            }
        });
    }, []);

    // --- Main Game Loop ---
    const gameLoop = useCallback(() => {
        if (!gameDataRef.current || gameDataRef.current.status !== 'playing') {
            return;
        }

        const now = Date.now();
        const deltaTime = (now - lastFrameTimeRef.current) / 1000;
        lastFrameTimeRef.current = now;

        const gameData = gameDataRef.current; // Mutate ref directly
        const { player } = gameData;
        
        // --- Player Movement (Click-to-Move) ---
        if (player.lives > 0 && targetPositionRef.current) {
            const target = targetPositionRef.current;
            const dx = target.x - (player.x + PLAYER_SIZE / 2);
            const dy = target.y - (player.y + PLAYER_SIZE / 2);
            const distance = Math.sqrt(dx * dx + dy * dy);

            let speedMultiplier = 1.0;
            if (gameData.stage === 1) speedMultiplier = 0.8;
            else if (gameData.stage === 3) speedMultiplier = 0.9;
            const currentPlayerSpeed = PLAYER_BASE_SPEED * speedMultiplier;

            if (distance > 5) { // Stop threshold
                player.x += (dx / distance) * currentPlayerSpeed * deltaTime;
                player.y += (dy / distance) * currentPlayerSpeed * deltaTime;
            } else {
                targetPositionRef.current = null; // Reached destination
            }
            player.x = Math.max(0, Math.min(gameData.width - PLAYER_SIZE, player.x));
            player.y = Math.max(0, Math.min(gameData.height - PLAYER_SIZE, player.y));
        }

        // --- Game Logic (Collision, Spawning, etc.) ---
        updateGameLogic(gameData, now, deltaTime);

        // --- Drawing ---
        if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            draw(ctx);
        }

        // --- UI Update (Throttled) ---
        if (now - lastUiUpdateTimeRef.current > 100) { // Update UI 10 times/sec
            setUiData({
                score: Math.floor(gameData.displayScore),
                time: gameData.remainingTime,
                stage: gameData.stage
            });
            lastUiUpdateTimeRef.current = now;
        }

        // --- State Transitions (Game Over, Stage Clear) ---
        if (gameData.status !== 'playing') {
            if (gameData.status === 'gameOver') {
                saveRanking(player.name, gameData.finalScore);
                setGameState('gameOver');
            } else if (gameData.status === 'stageClear') {
                setGameState('stageClear');
            }
        } else {
            gameLoopRef.current = requestAnimationFrame(gameLoop);
        }
    }, [draw, saveRanking]);


    // --- Start/Stop Game Loop ---
    useEffect(() => {
        if (gameState === 'playing') {
            lastFrameTimeRef.current = Date.now();
            lastUiUpdateTimeRef.current = Date.now();
            gameLoopRef.current = requestAnimationFrame(gameLoop);
        } else {
            if (gameLoopRef.current) {
                cancelAnimationFrame(gameLoopRef.current);
            }
        }
        return () => {
            if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
        };
    }, [gameState, gameLoop]);
    
    // --- Handle Page Visibility to Pause Game ---
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.hidden) {
                // Tab is not visible, pause the game
                if (gameLoopRef.current) {
                    cancelAnimationFrame(gameLoopRef.current);
                    gameLoopRef.current = null;
                    if (gameDataRef.current && gameDataRef.current.status === 'playing') {
                       gameDataRef.current.pauseStartTime = Date.now();
                    }
                }
            } else {
                // Tab is visible, resume the game
                if (gameState === 'playing' && !gameLoopRef.current) {
                    if (gameDataRef.current && gameDataRef.current.pauseStartTime > 0) {
                        const pausedDuration = Date.now() - gameDataRef.current.pauseStartTime;
                        gameDataRef.current.totalPausedTime += pausedDuration;
                        gameDataRef.current.pauseStartTime = 0;
                    }
                    lastFrameTimeRef.current = Date.now(); // Reset timer to prevent jump
                    gameLoopRef.current = requestAnimationFrame(gameLoop);
                }
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [gameState, gameLoop]);


    // --- Game Start Handler ---
    const handleStartGame = (startStage = 1, isDebug = false) => {
        const now = Date.now();
        const duration = isDebug ? DEBUG_STAGE_DURATION : STAGE_DURATION;
        
        gameDataRef.current = {
            player: { name: playerId, lives: 1, score: 0, x: GAME_WIDTH / 2 - PLAYER_SIZE / 2, y: GAME_HEIGHT - PLAYER_SIZE * 2, isInvincible: false, invincibleUntil: 0 },
            bullets: [], items: [], mathGems: [], floatingTexts: [], status: 'playing',
            gameStartTime: now, stageStartTime: now,
            totalTime: 0, 
            totalPausedTime: 0, 
            pausedTimeAtStageStart: 0,
            pauseStartTime: 0,
            displayScore: 0, remainingTime: duration,
            stage: startStage, stageDuration: duration,
            width: GAME_WIDTH, height: GAME_HEIGHT,
            lastBulletSpawn: now, lastHomingSpawn: now, lastSplitterSpawn: now, lastPatternSpawn: now,
            nextItemSpawnTime: now + getRandom(5000, 10000),
        };
        targetPositionRef.current = null;
        setGameState('playing');
    };
    
    // --- Next Stage Handler ---
    const handleNextStage = () => {
        const now = Date.now();
        const prevData = gameDataRef.current;
        const nextStage = prevData.stage + 1;
        const pausedDuration = prevData.pauseStartTime > 0 ? now - prevData.pauseStartTime : 0;
        const newTotalPausedTime = prevData.totalPausedTime + pausedDuration;
        
        gameDataRef.current = {
            ...prevData,
            player: { ...prevData.player, isInvincible: false, invincibleUntil: 0 },
            status: 'playing',
            bullets: [], items: [], mathGems: [], floatingTexts: [],
            stage: nextStage,
            stageStartTime: now,
            totalPausedTime: newTotalPausedTime,
            pausedTimeAtStageStart: newTotalPausedTime,
            pauseStartTime: 0,
            remainingTime: prevData.stageDuration,
            lastBulletSpawn: now, lastHomingSpawn: now, lastSplitterSpawn: now, lastPatternSpawn: now,
            nextItemSpawnTime: now + getRandom(5000, 10000),
        };
        targetPositionRef.current = null;
        setGameState('playing');
    };

    const handlePlayAgain = () => {
        setGameState('lobby');
        gameDataRef.current = null;
        fetchRankings();
    };
    
    // --- Input Handlers for Click-to-Move ---
    const updateTargetPosition = useCallback((e) => {
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        const touch = e.touches ? e.touches[0] : e;
        const canvasX = (touch.clientX - rect.left) * scaleX;
        const canvasY = (touch.clientY - rect.top) * scaleY;

        targetPositionRef.current = { x: canvasX, y: canvasY };
    }, []);

    const handlePointerDown = useCallback((e) => {
        e.preventDefault();
        isPointerDownRef.current = true;
        updateTargetPosition(e);
    }, [updateTargetPosition]);

    const handlePointerMove = useCallback((e) => {
        e.preventDefault();
        if (isPointerDownRef.current) {
            updateTargetPosition(e);
        }
    }, [updateTargetPosition]);

    const handlePointerUp = useCallback((e) => {
        e.preventDefault();
        isPointerDownRef.current = false;
    }, []);

    // --- Render Functions ---
    const renderLobby = () => ( <div className="w-full max-w-sm text-center bg-gray-800 p-8 rounded-xl shadow-lg"> <h1 className="text-4xl font-bold text-green-400 mb-2">봄바르딜로 크로코딜러를 구해줘</h1> <p className="text-gray-300 mb-8">v3.21 DudItem</p> <div className="mb-4 mt-8"> <p className="text-gray-400">플레이어 ID:</p> <p className="text-lg font-bold text-white">{playerId}</p> </div> <div className="space-y-4 mt-8"> <button onClick={() => handleStartGame(1, false)} className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-lg text-xl transition-transform transform hover:scale-105"> 게임 시작 </button> <div className="pt-4"> <h3 className="text-lg text-yellow-400 mb-2">[디버그: 스테이지 선택 (15초)]</h3> <div className="grid grid-cols-3 gap-2"> {[1, 2, 3, 4, 5, 6].map(stage => ( <button key={stage} onClick={() => handleStartGame(stage, true)} className="bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-3 rounded-lg"> S{stage} </button> ))} </div> </div> </div> <div className="mt-10"> <h2 className="text-2xl font-bold text-yellow-400 mb-4">🏆 학교 랭킹 🏆</h2> <div className="bg-gray-900 rounded-lg p-4 max-h-48 overflow-y-auto"> {rankings.length > 0 ? ( <ul className="space-y-2"> {rankings.map((r, index) => ( <li key={r.id} className={`flex justify-between items-center p-2 rounded ${index === 0 ? 'bg-yellow-500 text-gray-900 font-bold' : 'bg-gray-700'}`}> <span>{index + 1}. {r.playerId}</span> <span>{r.score} 점</span> </li> ))} </ul> ) : <p className="text-gray-400">랭킹을 불러오는 중...</p>} </div> </div> </div> );
    const renderGameOver = () => ( <div className="w-full max-w-sm text-center bg-gray-800 p-10 rounded-xl shadow-lg"> <h1 className="text-5xl font-bold text-red-500 mb-4">게임 오버</h1> <div className="bg-gray-700 p-4 rounded-lg mb-6"> <h2 className="text-xl text-yellow-400 mb-2">최종 점수</h2> {gameDataRef.current && <p className="text-2xl text-white font-bold">{Math.floor(gameDataRef.current.finalScore) || 0} 점</p>} </div> <div className="mt-6"> <h3 className="text-xl font-bold text-yellow-400 mb-2">🏆 Top 3 🏆</h3> <div className="space-y-2 text-white"> {rankings.slice(0, 3).map((r, i) => ( <div key={r.id} className="flex justify-between p-2 bg-gray-700 rounded-lg"> <span>{i+1}. {r.playerId}</span> <span>{r.score} 점</span> </div> ))} </div> </div> <button onClick={handlePlayAgain} className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-lg text-xl transition-transform transform hover:scale-105 mt-8"> 로비로 돌아가기 </button> </div> );
    const renderStageClear = () => ( <div className="w-full max-w-sm text-center bg-gray-800 p-10 rounded-xl shadow-lg flex flex-col items-center"> <h1 className="text-3xl font-bold text-green-400 mb-8"> 🐊 스테이지 클리어! 🐊 </h1> <p className="text-xl text-white mb-4"> 클리어한 스테이지: <span className="font-bold text-yellow-400">{gameDataRef.current?.stage}</span> </p> <button onClick={handleNextStage} className="w-full bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-4 rounded-lg text-xl transition-transform transform hover:scale-105"> 다음 스테이지 진행하기 </button> </div> );
    const renderGame = () => (
        <div className="flex flex-col items-center w-full h-full max-w-md mx-auto">
            <div className="w-full bg-gray-900 text-white p-2 rounded-t-lg flex justify-around items-center font-mono text-base">
                <span>🔥 S{uiData.stage}</span>
                <span>⏰ {uiData.stage > 5 ? '∞' : (uiData.time || 0)}</span>
                <span className="w-28 text-right">⭐ {uiData.score || 0}</span>
            </div>
            <canvas 
                ref={canvasRef}
                width={GAME_WIDTH}
                height={GAME_HEIGHT}
                className="border-4 border-gray-600 w-full rounded-b-lg"
                style={{ touchAction: 'none' }}
                onMouseDown={handlePointerDown}
                onMouseMove={handlePointerMove}
                onMouseUp={handlePointerUp}
                onMouseLeave={handlePointerUp}
                onTouchStart={handlePointerDown}
                onTouchMove={handlePointerMove}
                onTouchEnd={handlePointerUp}
                onTouchCancel={handlePointerUp}
            />
        </div>
    );

    return (
        <div className="w-screen h-screen bg-black text-white flex flex-col items-center justify-center p-2 sm:p-4 font-sans">
            {gameState === 'lobby' && renderLobby()}
            {gameState === 'playing' && renderGame()}
            {gameState === 'gameOver' && renderGameOver()}
            {gameState === 'stageClear' && renderStageClear()}
        </div>
    );
};


// --- Helper functions (moved outside component for clarity) ---

function updateGameLogic(gameData, now, deltaTime) {
    let { player } = gameData;
    
    const currentStagePausedTime = gameData.totalPausedTime - gameData.pausedTimeAtStageStart;
    const timeInStageMs = (now - gameData.stageStartTime) - currentStagePausedTime;
    const timeInStageSec = timeInStageMs / 1000;

    if (timeInStageSec >= gameData.stageDuration && gameData.stage < 6) {
        gameData.status = 'stageClear';
        gameData.remainingTime = 0;
        gameData.pauseStartTime = now;
        return;
    }
    
    const effectiveElapsedTime = (now - gameData.gameStartTime) - gameData.totalPausedTime;
    gameData.totalTime = Math.floor(effectiveElapsedTime / 1000);
    gameData.displayScore = player.score + effectiveElapsedTime * 0.01;
    gameData.remainingTime = gameData.stageDuration - Math.floor(timeInStageSec);

    const bulletsToSplit = [];
    gameData.bullets = gameData.bullets.filter(b => {
        if (b.isSplitter && now >= b.splitAt) {
            bulletsToSplit.push(b);
            return false;
        }
        return true;
    });
    bulletsToSplit.forEach(b => spawnCrossPattern(gameData, b.x, b.y, 150));

    gameData.bullets = gameData.bullets.map(b => {
        if (b.isHoming && player.lives > 0) {
            const angle = Math.atan2(player.y - b.y, player.x - b.x);
            b.dx += Math.cos(angle) * 3 * deltaTime;
            b.dy += Math.sin(angle) * 3 * deltaTime;
        }
        return { ...b, x: b.x + b.dx * deltaTime, y: b.y + b.dy * deltaTime };
    }).filter(b => b.x > -BULLET_SIZE && b.x < gameData.width && b.y > -BULLET_SIZE && b.y < gameData.height);

    generateBullets(gameData, now, timeInStageSec);

    if (now > gameData.nextItemSpawnTime) {
        const itemTypes = ['shield', '꽝', 'clear'];
        gameData.items.push({
            id: `i_${now}`, type: itemTypes[Math.floor(Math.random() * itemTypes.length)],
            x: getRandom(50, gameData.width - 50), y: getRandom(50, gameData.height - 50),
            expiresAt: now + ITEM_LIFESPAN
        });
        gameData.nextItemSpawnTime = now + getRandom(5000, 10000);
    }
    gameData.items = gameData.items.filter(i => i.expiresAt > now);
    gameData.mathGems = gameData.mathGems.filter(s => s.expiresAt > now);
    if (gameData.mathGems.length === 0) {
        gameData.mathGems.push(createMathGem(now, gameData.width, gameData.height));
    }
    gameData.floatingTexts = gameData.floatingTexts.filter(ft => ft.expiresAt > now);

    if (player.lives > 0 && !player.isInvincible) {
        const playerHitbox = { x: player.x + PLAYER_HITBOX_PADDING, y: player.y + PLAYER_HITBOX_PADDING, width: PLAYER_SIZE - 2 * PLAYER_HITBOX_PADDING, height: PLAYER_SIZE - 2 * PLAYER_HITBOX_PADDING };
        for (const bullet of gameData.bullets) {
            if (playerHitbox.x < bullet.x + BULLET_SIZE && playerHitbox.x + playerHitbox.width > bullet.x &&
                playerHitbox.y < bullet.y + BULLET_SIZE && playerHitbox.y + playerHitbox.height > bullet.y) {
                player.lives = 0;
                player.isInvincible = true;
                player.invincibleUntil = now + 2000;
                break;
            }
        }
    }
    
    gameData.items = gameData.items.filter(item => {
        if (player.lives > 0 && player.x < item.x + ITEM_SIZE && player.x + PLAYER_SIZE > item.x && player.y < item.y + ITEM_SIZE && player.y + PLAYER_SIZE > item.y) {
            switch(item.type) {
                case 'shield': player.isInvincible = true; player.invincibleUntil = now + 5000; break;
                case 'clear': gameData.bullets = []; break;
                default: break; // '꽝' item has no effect
            }
            return false;
        }
        return true;
    });

    gameData.mathGems = gameData.mathGems.filter(gem => {
        if (player.lives > 0 && player.x < gem.x + ITEM_SIZE * 1.5 && player.x + PLAYER_SIZE > gem.x && player.y < gem.y + ITEM_SIZE * 1.5 && player.y + PLAYER_SIZE > gem.y) {
            let scoreChange = 0;
            switch(gem.operator) {
                case '+': scoreChange = gem.value1 + gem.value2; break;
                case '-': scoreChange = gem.value1 - gem.value2; break;
                case '*': scoreChange = gem.value1 * gem.value2; break;
                case '/': scoreChange = gem.value2 !== 0 ? gem.value1 / gem.value2 : 0; break;
                default: break;
            }
            player.score += scoreChange;
            player.score = Math.max(0, player.score);
            gameData.floatingTexts.push({
                id: `ft_${now}`, text: `${scoreChange >= 0 ? '+' : ''}${Math.floor(scoreChange)}`,
                x: player.x, y: player.y, expiresAt: now + 1500
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
        gameData.status = 'gameOver';
        const finalElapsedTime = now - gameData.gameStartTime - gameData.totalPausedTime;
        const finalTotalTime = Math.floor(finalElapsedTime / 1000);
        gameData.finalScore = player.score + (finalTotalTime * 10);
    }
}

const createMathGem = (now, width, height) => {
    const operators = ['+', '-', '*', '/'];
    const operator = operators[Math.floor(Math.random() * operators.length)];
    let value1 = Math.floor(getRandom(-9, 10));
    let value2 = Math.floor(getRandom(-9, 10));
    if (operator === '/' && value2 === 0) { value2 = 1; }
    const text = `${value1}${operator === '*' ? '×' : operator}${value2}`;
    return { id: `g_${now}`, x: getRandom(50, width - 50), y: getRandom(50, height - 50), expiresAt: now + GEM_LIFESPAN, operator, value1, value2, text };
};

const spawnSideBullet = (gameData, speed, isSplitter = false) => {
    const b = { id: `b_${Date.now()}_${getRandom(0,999)}`, x: 0, y: 0, dx: 0, dy: 0, isSplitter: isSplitter, splitAt: isSplitter ? Date.now() + getRandom(1000, 2000) : 0 };
    const side = Math.floor(getRandom(0, 4));
    switch (side) {
        case 0: b.x = getRandom(0, gameData.width); b.y = -BULLET_SIZE; break;
        case 1: b.x = gameData.width; b.y = getRandom(0, gameData.height); break;
        case 2: b.x = getRandom(0, gameData.width); b.y = gameData.height; break;
        case 3: b.x = -BULLET_SIZE; b.y = getRandom(0, gameData.height); break;
        default: break;
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
const spawnImpossibleWallPattern = (gameData, speed, timeInStage) => { const side = Math.floor(getRandom(0, 4)); const isSecondHalf = timeInStage >= 30; const currentSpeed = speed * (isSecondHalf ? 1.5 : 1.0); const gapSize = PLAYER_SIZE * 2.2; const gapPosition = getRandom(PLAYER_SIZE, gameData.width - PLAYER_SIZE - gapSize); for (let i = 0; i < gameData.width; i += BULLET_SIZE * 1.5) { if (i > gapPosition && i < gapPosition + gapSize) continue; let b = { id: `b_${Date.now()}_${i}`, x: 0, y: 0, dx: 0, dy: 0 }; if (side < 2) { b.x = i; b.y = (side === 0 ? -BULLET_SIZE : gameData.height + BULLET_SIZE); b.dy = (side === 0 ? currentSpeed : -currentSpeed); } else { b.x = (side === 2 ? -BULLET_SIZE : gameData.width + BULLET_SIZE); b.y = i; b.dx = (side === 2 ? currentSpeed : -currentSpeed); } gameData.bullets.push(b); } };

const generateBullets = (gameData, now, timeInStage) => {
    const { stage, lastBulletSpawn, lastHomingSpawn, lastSplitterSpawn, lastPatternSpawn, stageDuration } = gameData;
    let speed;
    switch(stage) {
        case 1: speed = 108; const stage1Interval = 1000 - (timeInStage / stageDuration) * 800; if (now - lastBulletSpawn > Math.max(200, stage1Interval)) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } break;
        case 2: speed = 120; if (now - lastBulletSpawn > 700) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } if (now - lastHomingSpawn > 3000) { spawnHomingBullet(gameData, speed * 0.7); gameData.lastHomingSpawn = now; } break;
        case 3: speed = 132; if (now - lastBulletSpawn > 700) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } if (now - lastSplitterSpawn > 3000) { spawnSideBullet(gameData, speed, true); gameData.lastSplitterSpawn = now; } break;
        case 4: speed = 150; if (now - lastBulletSpawn > 600) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } if (now - lastHomingSpawn > 2800) { spawnHomingBullet(gameData, speed * 0.75); gameData.lastHomingSpawn = now; } if (now - lastSplitterSpawn > 2500) { spawnSideBullet(gameData, speed, true); gameData.lastSplitterSpawn = now; } break;
        case 5: speed = 228; if (now - lastBulletSpawn > 400) { spawnSideBullet(gameData, speed); gameData.lastBulletSpawn = now; } if (now - lastPatternSpawn > 5000) { spawnImpossibleWallPattern(gameData, 150, timeInStage); gameData.lastPatternSpawn = now; } break;
        default: const infiniteBonus = (stage - 6) * 50; const spawnInterval = 300 - infiniteBonus; speed = 240 + (stage - 6) * 12; if (now - lastBulletSpawn > Math.max(50, spawnInterval)) { spawnSideBullet(gameData, speed, true); if(Math.random() < 0.2) spawnAimedBullet(gameData, speed); if(Math.random() < 0.1) spawnHomingBullet(gameData, speed * 0.8); gameData.lastBulletSpawn = now; } break;
    }
};

// --- Main Page Export ---
export default function BombardilloCrocodilloPage() {
    return <Game />;
}