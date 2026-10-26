/**
 * FAKE MEDIA cho E2E headless: override getUserMedia/getDisplayMedia bằng
 * luồng canvas động (video) + oscillator (audio) — giúp kiểm tra WebRTC
 * đầy đủ mà không cần camera thật.
 */
(() => {
  if (!navigator.mediaDevices) return;
  const W = 1280;
  const H = 720;
  let counter = 0;

  const makeVideoTrack = (label) => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    let t = 0;
    const draw = () => {
      t += 0.02;
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "#1b3327");
      g.addColorStop(1, "#0e1c14");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      // mặt trời vàng
      ctx.fillStyle = "#eeb64e";
      ctx.beginPath();
      ctx.arc(1060, 170, 95 + Math.sin(t) * 10, 0, Math.PI * 2);
      ctx.fill();
      // bông phượng đỏ lượn
      ctx.fillStyle = "#e14b32";
      ctx.beginPath();
      ctx.arc(
        320 + Math.sin(t * 0.8) * 150,
        430 + Math.cos(t * 0.6) * 90,
        60,
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.fillStyle = "#f2ead9";
      ctx.font = "bold 72px Georgia";
      ctx.textAlign = "center";
      ctx.fillText(label, W / 2, 360);
      ctx.font = "30px Georgia";
      ctx.fillStyle = "#a3bca6";
      ctx.fillText("Lớp học trực tuyến — luồng giả lập E2E", W / 2, 430);
      requestAnimationFrame(draw);
    };
    draw();
    const stream = canvas.captureStream(30);
    return stream.getVideoTracks()[0];
  };

  const makeAudioTrack = () => {
    try {
      const ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0.03;
      osc.frequency.value = 220;
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      return dest.stream.getAudioTracks()[0];
    } catch {
      return null;
    }
  };

  const fake = (constraints, label) => {
    counter += 1;
    const c = constraints || {};
    const wantVideo = c.video !== false && c.video !== undefined;
    const wantAudio = c.audio !== false && c.audio !== undefined;
    const tracks = [];
    if (wantVideo) tracks.push(makeVideoTrack(label || "FAKE CAM " + counter));
    if (wantAudio) {
      const a = makeAudioTrack();
      if (a) tracks.push(a);
    }
    return Promise.resolve(new MediaStream(tracks));
  };

  const orig =
    navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (constraints) => {
    try {
      return fake(constraints, "FAKE CAM");
    } catch {
      return orig(constraints);
    }
  };
  try {
    const origDisplay =
      navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = (constraints) => {
      try {
        return fake(constraints, "FAKE SCREEN");
      } catch {
        return origDisplay(constraints);
      }
    };
  } catch {
    // getDisplayMedia có thể không có — bỏ qua.
  }
})();
