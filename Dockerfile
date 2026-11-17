# 抖音云自定义镜像部署用（模板部署无需此文件，平台会自动生成）
# 构建：docker build -t miao-erase --platform linux/amd64 .
FROM node:18-alpine

# 抖音云容器默认 UTC 时区，这里显式设为北京时间（配额按日统计依赖 UTC+8，
# 代码里已用 UTC+8 计算日期键，设 TZ 只是让日志时间更直观）
ENV TZ=Asia/Shanghai
WORKDIR /opt/application

# 先装依赖，利用镜像层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# 平台通过 /opt/application/run.sh 启动，必须可执行
RUN chmod a+x run.sh

EXPOSE 8000
CMD ["/opt/application/run.sh"]
