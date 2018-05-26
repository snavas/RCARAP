// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

document.getElementById('createSession').addEventListener("click", function() {
	console.log("clicked on Create Session")
    let io = require('socket.io').listen(3000);
    io.on('connection', function(socket) {
        console.log('connected:', socket.client.id);
        socket.on('serverEvent', function(data) {
            console.log('new message from client:', data);
        });
        setInterval(function() {
            socket.emit('clientEvent', data);
            console.log('message sent to the clients');
        }, 200);
    });
});
document.getElementById('joinSession').addEventListener("click", function() {
    let io = require('socket.io-client');
    let hostIP = document.getElementById('joinSessionId').value;
    console.log(hostIP);
    let socket = io.connect(hostIP + ":3000/", {
        reconnection: true
    });

    socket.on('connect', function() {
        console.log('connected to localhost:3000');
        socket.on('clientEvent', function(data) {
            console.log('message from the server:', data);
            socket.emit('serverEvent', "thanks server! for sending '" + data + "'");
        });
    });
});
document.getElementById('startStreaming').addEventListener("click", function() {
    startVideo();
});

function startVideo() {	
    let windowIsOpen = true;
    const cv = require('opencv4nodejs');
    const rs2 = require('node-librealsense/index.js');
    /*const {
        GLFWWindow
    } = require('./glfw-window.js'); //for demo, visualiazation will be the projection
    const win = new GLFWWindow(1280, 720, 'Node.js Capture Example');*/

    //distance in depth image in different colors
    const colorizer = new rs2.Colorizer();

    const pipeline = new rs2.Pipeline();
    pipeline.start();
    while (windowIsOpen) {
        const frameset = pipeline.waitForFrames();
        const depthMap = colorizer.colorize(frameset.depthFrame);
        if (depthMap) {
            //win.beginPaint();
            const color = frameset.colorFrame;
            const colorMat = new cv.Mat(color.data, color.height, color.width, cv.CV_8UC3);
            const grayMat = colorMat.bgrToGray();


            //Kopie von handrecog.js
            // segmenting by skin color (has to be adjusted)
            const skinColorUpper = hue => new cv.Vec(hue, 0.8 * 255, 0.6 * 255);
            const skinColorLower = hue => new cv.Vec(hue, 0.1 * 255, 0.05 * 255);

            const makeHandMask = (img) => {
                // filter by skin color
                const imgHLS = img.cvtColor(cv.COLOR_RGB2HLS);
                //const imgRGB = img.cvtColor(cv.COLOR_BGR2HLS);
                const rangeMask = imgHLS.inRange(skinColorLower(5), skinColorUpper(80));
                //cv.imshow('img', imgHLS);
                //cv.imshow('imgrgb',imgRGB);

                // remove noise
                const blurred = rangeMask.blur(new cv.Size(10, 10));
                const thresholded = blurred.threshold(200, 255, cv.THRESH_BINARY);
                return thresholded;
            };

            const getHandContour = (handMask) => {
                const mode = cv.RETR_EXTERNAL;
                const method = cv.CHAIN_APPROX_SIMPLE;
                const contours = handMask.findContours(mode, method);
                // largest contour
                return contours.sort((c0, c1) => c1.area - c0.area)[0];
            };

            // returns distance of two points
            const ptDist = (pt1, pt2) => pt1.sub(pt2).norm();

            // returns center of all points
            const getCenterPt = pts => pts.reduce(
                (sum, pt) => sum.add(pt),
                new cv.Point(0, 0)
            ).div(pts.length);

            // get the polygon from a contours hull such that there
            // will be only a single hull point for a local neighborhood
            const getRoughHull = (contour, maxDist) => {
                // get hull indices and hull points
                const hullIndices = contour.convexHullIndices();
                const contourPoints = contour.getPoints();
                const hullPointsWithIdx = hullIndices.map(idx => ({
                    pt: contourPoints[idx],
                    contourIdx: idx
                }));
                const hullPoints = hullPointsWithIdx.map(ptWithIdx => ptWithIdx.pt);

                // group all points in local neighborhood
                const ptsBelongToSameCluster = (pt1, pt2) => ptDist(pt1, pt2) < maxDist;
                const {
                    labels
                } = cv.partition(hullPoints, ptsBelongToSameCluster);
                const pointsByLabel = new Map();
                labels.forEach(l => pointsByLabel.set(l, []));
                hullPointsWithIdx.forEach((ptWithIdx, i) => {
                    const label = labels[i];
                    pointsByLabel.get(label).push(ptWithIdx);
                });

                // map points in local neighborhood to most central point
                const getMostCentralPoint = (pointGroup) => {
                    // find center
                    const center = getCenterPt(pointGroup.map(ptWithIdx => ptWithIdx.pt));
                    // sort ascending by distance to center
                    return pointGroup.sort(
                        (ptWithIdx1, ptWithIdx2) => ptDist(ptWithIdx1.pt, center) - ptDist(ptWithIdx2.pt, center)
                    )[0];
                };
                const pointGroups = Array.from(pointsByLabel.values());
                // return contour indeces of most central points
                return pointGroups.map(getMostCentralPoint).map(ptWithIdx => ptWithIdx.contourIdx);
            };

            const getHullDefectVertices = (handContour, hullIndices) => {
                const defects = handContour.convexityDefects(hullIndices);
                const handContourPoints = handContour.getPoints();

                // get neighbor defect points of each hull point
                const hullPointDefectNeighbors = new Map(hullIndices.map(idx => [idx, []]));
                defects.forEach((defect) => {
                    const startPointIdx = defect.at(0);
                    const endPointIdx = defect.at(1);
                    const defectPointIdx = defect.at(2);
                    hullPointDefectNeighbors.get(startPointIdx).push(defectPointIdx);
                    hullPointDefectNeighbors.get(endPointIdx).push(defectPointIdx);
                });

                return Array.from(hullPointDefectNeighbors.keys())
                    // only consider hull points that have 2 neighbor defects
                    .filter(hullIndex => hullPointDefectNeighbors.get(hullIndex).length > 1)
                    // return vertex points
                    .map((hullIndex) => {
                        const defectNeighborsIdx = hullPointDefectNeighbors.get(hullIndex);
                        return ({
                            pt: handContourPoints[hullIndex],
                            d1: handContourPoints[defectNeighborsIdx[0]],
                            d2: handContourPoints[defectNeighborsIdx[1]]
                        });
                    });
            };

            const filterVerticesByAngle = (vertices, maxAngleDeg) =>
                vertices.filter((v) => {
                    const sq = x => x * x;
                    const a = v.d1.sub(v.d2).norm();
                    const b = v.pt.sub(v.d1).norm();
                    const c = v.pt.sub(v.d2).norm();
                    const angleDeg = Math.acos(((sq(b) + sq(c)) - sq(a)) / (2 * b * c)) * (180 / Math.PI);
                    return angleDeg < maxAngleDeg;
                });

            const blue = new cv.Vec(255, 0, 0);
            const green = new cv.Vec(0, 255, 0);
            const red = new cv.Vec(0, 0, 255);

            // main
            const delay = 20;
            const resizedImg = colorMat.resizeToMax(640);

            //            while(true){
            const handMask = makeHandMask(resizedImg);
            const handContour = getHandContour(handMask);

            if (!handContour) {
                return;
            }

            const maxPointDist = 25;
            const hullIndices = getRoughHull(handContour, maxPointDist);

            // get defect points of hull to contour and return vertices
            // of each hull point to its defect points
            const vertices = getHullDefectVertices(handContour, hullIndices);

            // fingertip points are those which have a sharp angle to its defect points
            const maxAngleDeg = 60;
            const verticesWithValidAngle = filterVerticesByAngle(vertices, maxAngleDeg);

            const result = resizedImg.copy();
            // draw bounding box and center line
            resizedImg.drawContours(
                [handContour],
                blue, {
                    thickness: 2
                }
            );

            // draw points and vertices
            verticesWithValidAngle.forEach((v) => {
                resizedImg.drawLine(
                    v.pt,
                    v.d1, {
                        color: green,
                        thickness: 2
                    }
                );
                resizedImg.drawLine(
                    v.pt,
                    v.d2, {
                        color: green,
                        thickness: 2
                    }
                );
                resizedImg.drawEllipse(
                    new cv.RotatedRect(v.pt, new cv.Size(20, 20), 0), {
                        color: red,
                        thickness: 2
                    }
                );
                result.drawEllipse(
                    new cv.RotatedRect(v.pt, new cv.Size(20, 20), 0), {
                        color: red,
                        thickness: 2
                    }
                );
            });



            // display detection result
            const numFingersUp = verticesWithValidAngle.length;
            result.drawRectangle(
                new cv.Point(10, 10),
                new cv.Point(70, 70), {
                    color: green,
                    thickness: 2
                }
            );

            const fontScale = 2;
            result.putText(
                String(numFingersUp),
                new cv.Point(20, 60),
                cv.FONT_ITALIC,
                fontScale, {
                    color: green,
                    thickness: 2
                }
            );

            const {
                rows,
                cols
            } = result;
            const sideBySide = new cv.Mat(rows, cols * 2, cv.CV_8UC3);
            result.copyTo(sideBySide.getRegion(new cv.Rect(0, 0, cols, rows)));
            resizedImg.copyTo(sideBySide.getRegion(new cv.Rect(cols, 0, cols, rows)));
            //cv.imshow('handMask', handMask);
            //cv.imshow("result", result);

            //cv.imshow('cv demo', grayMat); //for demo, visualiazation will be the projection            
            //win.endPaint();
            //}
        }

    }

    pipeline.stop();
    pipeline.destroy();
    //win.destroy();
    rs2.cleanup();
}

function setWindowIsOpen(val) {
    windowIsOpen = val;
}